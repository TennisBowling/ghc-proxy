import type { CopilotClient } from '~/clients'
import type { CapiRequestContext } from '~/core/capi'
import type { StrategyEntry } from '~/dispatch'
import type { ModelMappingInfo } from '~/lib/request-logger'
import type { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'
import type { ChatCompletionsPayload, Model } from '~/types'

import consola from 'consola'
import { CopilotTransport, OpenAIChatAdapter } from '~/adapters'
import { StrategyRegistry } from '~/dispatch'
import { runStrategy } from '~/lib/execution-strategy'
import { appendModelStepInPlace } from '~/lib/request-logger'
import { modelCache, RESPONSES_ENDPOINT } from '~/state'

import { createChatCompletionsViaResponsesStrategy } from './responses-strategy'
import { createChatCompletionsStrategy } from './strategy'

export interface ChatCompletionsStrategyContext {
  copilotClient: CopilotClient
  payload: ChatCompletionsPayload
  upstreamSignal: ReturnType<typeof createUpstreamSignalFromConfig>
  requestContext: Partial<CapiRequestContext>
  modelMapping: ModelMappingInfo
  selectedModel?: Model
}

function hasFileInput(payload: ChatCompletionsPayload): boolean {
  return payload.messages.some(
    message => Array.isArray(message.content)
      && message.content.some(part => part.type === 'file'),
  )
}

function shouldUseResponsesBackend(model: Model | undefined, payload: ChatCompletionsPayload): boolean {
  return modelCache.supportsEndpoint(model, RESPONSES_ENDPOINT)
    && (!modelCache.supportsEndpoint(model, '/chat/completions') || hasFileInput(payload))
}

function hasVisionInput(payload: ChatCompletionsPayload): boolean {
  return payload.messages.some(
    message => Array.isArray(message.content)
      && message.content.some(part => part.type === 'image_url'),
  )
}

function inferInitiator(payload: ChatCompletionsPayload): 'user' | 'agent' {
  return payload.messages.some(message => message.role === 'assistant' || message.role === 'tool')
    ? 'agent'
    : 'user'
}

function excludesReasoning(payload: ChatCompletionsPayload): boolean {
  return payload.reasoning?.exclude === true || payload.include_reasoning === false
}

const chatCompletionsEntry: StrategyEntry<ChatCompletionsStrategyContext> = {
  name: 'chat-completions',
  canHandle: () => true,
  async execute(ctx) {
    if (shouldUseResponsesBackend(ctx.selectedModel, ctx.payload)) {
      appendModelStepInPlace(ctx.modelMapping, 'MODEL_RESOLVE', ctx.payload.model)
      const strategy = createChatCompletionsViaResponsesStrategy(ctx.copilotClient, ctx.payload, {
        signal: ctx.upstreamSignal.signal,
        requestContext: ctx.requestContext,
        vision: hasVisionInput(ctx.payload),
        initiator: inferInitiator(ctx.payload),
      })
      return await runStrategy(strategy, ctx.upstreamSignal)
    }

    const adapter = new OpenAIChatAdapter({ excludeReasoning: excludesReasoning(ctx.payload) })
    const plan = adapter.toCapiPlan(ctx.payload, {
      requestContext: ctx.requestContext,
    })

    appendModelStepInPlace(ctx.modelMapping, 'MODEL_RESOLVE', plan.resolvedModel)

    const transport = new CopilotTransport(ctx.copilotClient)

    consola.debug('Streaming response')
    const strategy = createChatCompletionsStrategy(transport, adapter, plan, ctx.upstreamSignal.signal)
    return await runStrategy(strategy, ctx.upstreamSignal)
  },
}

export const chatCompletionsStrategyRegistry = new StrategyRegistry<ChatCompletionsStrategyContext>()
chatCompletionsStrategyRegistry.register(chatCompletionsEntry)
