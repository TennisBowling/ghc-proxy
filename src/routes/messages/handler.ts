import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ModelMappingInfo, ModelTransformStep } from '~/lib/request-logger'
import consola from 'consola'

import { normalizeAnthropicRequestContext } from '~/core/capi/request-context'
import { applyModelRewrite, getContextUpgradeTarget, isContextLengthError } from '~/lib/model-rewrite'
import { applyMessagesModelPolicy } from '~/lib/request-model-policy'
import { createCopilotClient } from '~/lib/state'
import { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'
import { parseAnthropicMessagesPayload } from '~/lib/validation'
import { configStore, modelCache } from '~/state'
import { processAnthropicBetaHeader } from '~/transform/beta-headers'

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
  const steps: ModelTransformStep[] = []
  if (rewrite.reason) {
    steps.push({ tag: rewrite.reason, from: rewrite.originalModel, to: rewrite.model })
  }

  // Stage 2: Beta header processing (context-1m upgrade + filter)
  const betaResult = processAnthropicBetaHeader(
    headers.get('anthropic-beta'),
    anthropicPayload.model,
  )
  if (betaResult.upgradeTarget) {
    consola.debug(`Beta header context upgrade: ${anthropicPayload.model} → ${betaResult.upgradeTarget}`)
    steps.push({ tag: 'BETA_UPGRADE', from: anthropicPayload.model, to: betaResult.upgradeTarget })
    anthropicPayload.model = betaResult.upgradeTarget
  }

  // Stage 3: Model policy (skip proactive context upgrade if already upgraded by beta)
  const anthropicBetaHeader = betaResult.header
  const modelRouting = applyMessagesModelPolicy(
    anthropicPayload,
    { betaUpgraded: !!betaResult.upgradeTarget },
  )
  if (modelRouting.reason === 'context-upgrade') {
    steps.push({ tag: 'CONTEXT_UPGRADE', from: modelRouting.originalModel, to: modelRouting.routedModel })
  }
  else if (modelRouting.reason === 'compact') {
    steps.push({ tag: 'COMPACT', from: modelRouting.originalModel, to: modelRouting.routedModel })
  }
  const modelMapping: ModelMappingInfo = {
    originalModel: rewrite.originalModel,
    steps,
  }

  if (modelRouting.reason) {
    consola.debug(
      `Routed anthropic request via ${modelRouting.reason}:`,
      `${modelRouting.originalModel} -> ${modelRouting.routedModel}`,
    )
  }

  const selectedModel = modelCache.findById(anthropicPayload.model)
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
    const upgradeTarget = configStore.isContextUpgradeEnabled() && isContextLengthError(error)
      ? getContextUpgradeTarget(anthropicPayload.model)
      : undefined

    if (!upgradeTarget)
      throw error

    consola.info(
      `Context length exceeded, retrying: ${anthropicPayload.model} → ${upgradeTarget}`,
    )
    const retryFrom = anthropicPayload.model
    anthropicPayload.model = upgradeTarget
    const retryModel = modelCache.findById(upgradeTarget)
    const retrySignal = createUpstreamSignalFromConfig(signal)
    const retryEntry = selectStrategy(defaultStrategyRegistry, retryModel)
    strategyResult = await retryEntry.execute({
      ...strategyCtx,
      anthropicPayload,
      selectedModel: retryModel,
      upstreamSignal: retrySignal,
      modelMapping: {
        originalModel: rewrite.originalModel,
        steps: [...steps, { tag: 'RETRY_UPGRADE', from: retryFrom, to: upgradeTarget }],
      },
    })
  }

  return {
    result: strategyResult.result,
    modelMapping: strategyResult.modelMapping,
  }
}
