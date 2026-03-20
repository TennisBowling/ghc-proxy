import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ModelMappingInfo } from '~/lib/request-logger'
import consola from 'consola'

import { readCapiRequestContext } from '~/core/capi'
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

/**
 * Core handler for Anthropic messages endpoint.
 * Returns both the execution result and model mapping info.
 */
export async function handleMessagesCore(
  { body, signal, headers }: MessagesCoreParams,
): Promise<MessagesCoreResult> {
  const anthropicPayload = parseAnthropicMessagesPayload(body)
  if (consola.level >= 4)
    consola.debug('Anthropic request payload:', JSON.stringify(anthropicPayload))

  // Stage 1: Model rewrite (normalize + user rules)
  const rewrite = applyModelRewrite(anthropicPayload)

  const anthropicBetaHeader = headers.get('anthropic-beta') ?? undefined
  const modelRouting = applyMessagesModelPolicy(
    anthropicPayload,
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
    requestContext: readCapiRequestContext(headers),
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
