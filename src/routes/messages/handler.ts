import type { CapiRequestContext } from '~/core/capi'
import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ModelMappingInfo, ModelTransformTag } from '~/lib/request-logger'
import type { AnthropicMessagesPayload } from '~/translator'
import consola from 'consola'

import { executeWithContextRetry } from '~/dispatch/error-recovery'
import { protocolRegistry } from '~/ingest'
import { createCopilotClient } from '~/lib/state'
import { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'
import { modelCache } from '~/state'
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
  const { payload: anthropicPayload, meta } = protocolRegistry.ingest<AnthropicMessagesPayload>(
    'anthropic-messages',
    body,
    headers,
  )
  const requestContext = meta.requestContext as Partial<CapiRequestContext>
  if (consola.level >= 4)
    consola.debug('Anthropic request payload:', JSON.stringify(anthropicPayload))

  // Parse beta headers for both the transform chain and strategy context
  const betaResult = processAnthropicBetaHeader(
    headers.get('anthropic-beta'),
    anthropicPayload.model,
  )
  const anthropicBetaHeader = betaResult.header

  // Run the 3-step model transform chain (rewrite → beta upgrade → policy)
  const transformResult = messagesModelChain.apply({
    model: anthropicPayload.model,
    payload: anthropicPayload,
    headers,
    meta: { betaHeaders: meta.betaHeaders },
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

  const strategyResult = await executeWithContextRetry(
    async (model) => {
      const currentPayload = { ...anthropicPayload, model }
      const currentModel = model === anthropicPayload.model ? selectedModel : modelCache.findById(model)
      const currentEntry = selectStrategy(defaultStrategyRegistry, currentModel)
      const currentSignal = model === anthropicPayload.model ? upstreamSignal : createUpstreamSignalFromConfig(signal)
      const sr = await currentEntry.execute({
        copilotClient,
        anthropicPayload: currentPayload,
        anthropicBetaHeader,
        selectedModel: currentModel,
        upstreamSignal: currentSignal,
        headers,
        requestContext,
        modelMapping,
      })
      return sr.result
    },
    { model: anthropicPayload.model, trace: modelMapping.steps.map(s => ({ tag: s.tag, from: s.from, to: s.to })) },
  )

  return { result: strategyResult, modelMapping }
}
