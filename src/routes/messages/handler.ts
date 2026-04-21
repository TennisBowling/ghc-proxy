import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ModelMappingInfo, ModelTransformTag } from '~/lib/request-logger'
import consola from 'consola'

import { normalizeAnthropicRequestContext } from '~/core/capi/request-context'
import { getContextUpgradeTarget, isContextLengthError } from '~/lib/model-rewrite'
import { createCopilotClient } from '~/lib/state'
import { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'
import { parseAnthropicMessagesPayload } from '~/lib/validation'
import { configStore, modelCache } from '~/state'
import { messagesModelChain, processAnthropicBetaHeader } from '~/transform'

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

  // Parse beta headers for both the transform chain and strategy context
  const betaResult = processAnthropicBetaHeader(
    headers.get('anthropic-beta'),
    anthropicPayload.model,
  )
  const anthropicBetaHeader = betaResult.header

  // Run the 3-step model transform chain (rewrite → beta upgrade → policy)
  const rawBeta = headers.get('anthropic-beta')
  const betaHeaders = rawBeta ? rawBeta.split(',').map(v => v.trim()).filter(Boolean) : undefined
  const transformResult = messagesModelChain.apply({
    model: anthropicPayload.model,
    payload: anthropicPayload,
    headers,
    meta: { betaHeaders },
  })

  // Apply the final model from the chain
  anthropicPayload.model = transformResult.model
  const selectedModel = transformResult.resolvedModel

  const originalModel = transformResult.trace.length > 0
    ? transformResult.trace[0].from
    : anthropicPayload.model
  const modelMapping: ModelMappingInfo = {
    originalModel,
    steps: transformResult.trace.map(r => ({
      tag: r.tag as ModelTransformTag,
      from: r.from,
      to: r.to,
    })),
  }

  if (transformResult.trace.length > 0) {
    consola.debug(
      `Model transform chain:`,
      transformResult.trace.map(r => `${r.from}-[${r.tag}]->${r.to}`).join(', '),
    )
  }

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
        originalModel,
        steps: [...modelMapping.steps, { tag: 'RETRY_UPGRADE', from: retryFrom, to: upgradeTarget }],
      },
    })
  }

  return {
    result: strategyResult.result,
    modelMapping: strategyResult.modelMapping,
  }
}
