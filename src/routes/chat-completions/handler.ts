import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ModelMappingInfo, ModelTransformTag } from '~/lib/request-logger'
import type { ChatCompletionsPayload } from '~/types'

import consola from 'consola'
import { protocolRegistry } from '~/ingest'
import { createCopilotClient } from '~/lib/state'
import { getTokenCount } from '~/lib/tokenizer'
import { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'
import { modelCache } from '~/state'
import { chatCompletionsModelChain } from '~/transform'

import { chatCompletionsStrategyRegistry } from './strategy-registry'

export interface CompletionCoreParams {
  body: unknown
  signal: AbortSignal
  headers: Headers
}

export interface CompletionCoreResult {
  result: ExecutionResult
  modelMapping?: ModelMappingInfo
}

/**
 * Core handler for chat completions.
 */
export async function handleCompletionCore(
  { body, signal, headers }: CompletionCoreParams,
): Promise<CompletionCoreResult> {
  const { payload: parsedPayload, meta } = protocolRegistry.ingest<ChatCompletionsPayload>(
    'openai-chat',
    body,
    headers,
  )
  let payload = parsedPayload
  const requestContext = meta.requestContext as Partial<import('~/core/capi').CapiRequestContext>
  consola.debug('Request payload:', JSON.stringify(payload).slice(-400))

  // Run model transform chain (rewrite step)
  const transformResult = chatCompletionsModelChain.apply({ model: payload.model, payload, headers })
  payload.model = transformResult.model

  const selectedModel = modelCache.findById(payload.model)

  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      consola.info('Current token count:', tokenCount)
    }
    else {
      consola.warn('No model selected, skipping token count calculation')
    }
  }
  catch (error) {
    consola.warn('Failed to calculate token count:', error)
  }

  if (payload.max_tokens == null) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    consola.debug('Set max_tokens to:', JSON.stringify(payload.max_tokens))
  }

  const upstreamSignal = createUpstreamSignalFromConfig(signal)
  const copilotClient = createCopilotClient()

  const originalModel = transformResult.trace.length > 0 ? transformResult.trace[0].from : payload.model
  const modelMapping: ModelMappingInfo = {
    originalModel,
    steps: transformResult.trace.map(r => ({ tag: r.tag as ModelTransformTag, from: r.from, to: r.to })),
  }

  const entry = chatCompletionsStrategyRegistry.select(selectedModel)
  const result = await entry.execute({
    copilotClient,
    payload,
    upstreamSignal,
    requestContext,
    modelMapping,
  })

  return { result, modelMapping }
}
