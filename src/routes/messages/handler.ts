import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ModelMappingInfo } from '~/lib/request-logger'
import consola from 'consola'

import { normalizeAnthropicRequestContext } from '~/core/capi/request-context'
import { shouldContextUpgrade } from '~/lib/config'
import { findModelById } from '~/lib/model-capabilities'
import { applyModelRewrite, getContextUpgradeTarget, isContextLengthError } from '~/lib/model-rewrite'
import { applyMessagesModelPolicy } from '~/lib/request-model-policy'
import { createCopilotClient } from '~/lib/state'
import { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'
import { parseAnthropicMessagesPayload } from '~/lib/validation'

import { defaultStrategyRegistry, selectStrategy } from './strategy-registry'

export interface MessagesCoreParams {
  body: unknown
  signal: AbortSignal
  headers: Headers
}

export interface MessagesCoreResult {
  result: ExecutionResult
  modelMapping?: ModelMappingInfo
}

const CONTEXT_BETA_RE = /^context-\d+[km]-/

interface BetaHeaderResult {
  header: string | undefined
  upgradeTarget: string | undefined
}

export function processAnthropicBetaHeader(
  rawHeader: string | null,
  model: string,
): BetaHeaderResult {
  if (!rawHeader)
    return { header: undefined, upgradeTarget: undefined }

  const values = rawHeader.split(',').map(v => v.trim()).filter(Boolean)
  let upgradeTarget: string | undefined
  const filtered: string[] = []

  for (const value of values) {
    if (CONTEXT_BETA_RE.test(value)) {
      // Always strip context-* betas — Copilot doesn't understand them.
      // If context upgrade is enabled and a target exists, apply it.
      if (!upgradeTarget && shouldContextUpgrade()) {
        const target = getContextUpgradeTarget(model)
        if (target) {
          upgradeTarget = target
        }
      }
      continue
    }
    filtered.push(value)
  }

  return {
    header: filtered.length > 0 ? filtered.join(',') : undefined,
    upgradeTarget,
  }
}

/**
 * Core handler for Anthropic messages endpoint.
 * Returns both the execution result and model mapping info.
 */
export async function handleMessagesCore(
  { body, signal, headers }: MessagesCoreParams,
): Promise<MessagesCoreResult> {
  const anthropicPayload = parseAnthropicMessagesPayload(body)
  const requestContext = normalizeAnthropicRequestContext(anthropicPayload, headers)
  if (consola.level >= 4)
    consola.debug('Anthropic request payload:', JSON.stringify(anthropicPayload))

  // Stage 1: Model rewrite (normalize + user rules)
  const rewrite = applyModelRewrite(anthropicPayload)

  // Stage 2: Beta header processing (context-1m upgrade + filter)
  const betaResult = processAnthropicBetaHeader(
    headers.get('anthropic-beta'),
    anthropicPayload.model,
  )
  if (betaResult.upgradeTarget) {
    consola.debug(`Beta header context upgrade: ${anthropicPayload.model} → ${betaResult.upgradeTarget}`)
    anthropicPayload.model = betaResult.upgradeTarget
  }

  // Stage 3: Model policy (skip proactive context upgrade if already upgraded by beta)
  const anthropicBetaHeader = betaResult.header
  const modelRouting = applyMessagesModelPolicy(
    anthropicPayload,
    { betaUpgraded: !!betaResult.upgradeTarget },
  )
  const modelMapping: ModelMappingInfo = {
    originalModel: rewrite.originalModel,
    rewrittenModel: rewrite.model,
    mappedModel: modelRouting.routedModel,
  }

  if (modelRouting.reason) {
    consola.debug(
      `Routed anthropic request via ${modelRouting.reason}:`,
      `${modelRouting.originalModel} -> ${modelRouting.routedModel}`,
    )
  }

  const selectedModel = findModelById(anthropicPayload.model)
  const upstreamSignal = createUpstreamSignalFromConfig(signal)
  const copilotClient = createCopilotClient()

  const entry = selectStrategy(defaultStrategyRegistry, selectedModel)

  const strategyCtx = {
    copilotClient,
    anthropicPayload,
    anthropicBetaHeader,
    selectedModel,
    upstreamSignal,
    headers,
    requestContext,
    modelMapping,
  }

  let strategyResult
  try {
    strategyResult = await entry.execute(strategyCtx)
  }
  catch (error) {
    const upgradeTarget = shouldContextUpgrade() && isContextLengthError(error)
      ? getContextUpgradeTarget(anthropicPayload.model)
      : undefined

    if (!upgradeTarget)
      throw error

    consola.info(
      `Context length exceeded, retrying: ${anthropicPayload.model} → ${upgradeTarget}`,
    )
    anthropicPayload.model = upgradeTarget
    const retryModel = findModelById(upgradeTarget)
    const retrySignal = createUpstreamSignalFromConfig(signal)
    const retryEntry = selectStrategy(defaultStrategyRegistry, retryModel)
    strategyResult = await retryEntry.execute({
      ...strategyCtx,
      anthropicPayload,
      selectedModel: retryModel,
      upstreamSignal: retrySignal,
      modelMapping: { originalModel: rewrite.originalModel, rewrittenModel: rewrite.model, mappedModel: upgradeTarget },
    })
  }

  return {
    result: strategyResult.result,
    modelMapping: strategyResult.modelMapping,
  }
}
