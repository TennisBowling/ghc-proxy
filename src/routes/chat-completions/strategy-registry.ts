import type { CopilotClient } from '~/clients'
import type { CapiRequestContext } from '~/core/capi'
import type { StrategyEntry } from '~/dispatch'
import type { ModelMappingInfo, ModelTransformTag } from '~/lib/request-logger'
import type { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'
import type { ChatCompletionsPayload } from '~/types'

import consola from 'consola'
import { CopilotTransport, OpenAIChatAdapter } from '~/adapters'
import { StrategyRegistry } from '~/dispatch'
import { runStrategy } from '~/lib/execution-strategy'
import { getEffectiveModel } from '~/lib/request-logger'

import { createChatCompletionsStrategy } from './strategy'

export interface ChatCompletionsStrategyContext {
  copilotClient: CopilotClient
  payload: ChatCompletionsPayload
  upstreamSignal: ReturnType<typeof createUpstreamSignalFromConfig>
  requestContext: Partial<CapiRequestContext>
  modelMapping: ModelMappingInfo
}

/**
 * Mutate `modelMapping` in place by appending a transform step.
 * `appendModelStep` from request-logger returns a new object, but here
 * the handler holds a reference to the same `modelMapping` passed into
 * the strategy context, so we need to push directly.
 */
function appendModelStepInPlace(
  info: ModelMappingInfo,
  tag: ModelTransformTag,
  newModel: string,
): void {
  const current = getEffectiveModel(info)
  if (newModel !== current) {
    info.steps.push({ tag, from: current, to: newModel })
  }
}

const chatCompletionsEntry: StrategyEntry<ChatCompletionsStrategyContext> = {
  name: 'chat-completions',
  canHandle: () => true,
  async execute(ctx) {
    const adapter = new OpenAIChatAdapter()
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
