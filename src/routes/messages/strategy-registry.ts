import type { CopilotClient } from '~/clients'
import type { CapiRequestContext } from '~/core/capi'
import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ModelMappingInfo } from '~/lib/request-logger'
import type { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'
import type { AnthropicMessagesPayload } from '~/translator'

import type { Model } from '~/types'
import consola from 'consola'
import { CopilotTransport } from '~/adapters'
import { withTranslationErrors } from '~/lib/error'
import { runStrategy } from '~/lib/execution-strategy'
import { appendModelStep } from '~/lib/request-logger'
import { configStore, MESSAGES_ENDPOINT, modelCache, RESPONSES_ENDPOINT } from '~/state'
import { translateAnthropicToResponsesPayload } from '~/translator/responses/anthropic-to-responses'
import { SignatureCodec } from '~/translator/responses/signature-codec'

import { applyContextManagement, compactInputByLatestCompaction, getResponsesRequestOptions } from '../responses/context-management'
import { createAnthropicAdapter } from './shared'
import { createMessagesViaChatCompletionsStrategy } from './strategies/chat-completions'
import { createNativeMessagesStrategy } from './strategies/native-messages'
import { createMessagesViaResponsesStrategy } from './strategies/responses-api'

export interface StrategyContext {
  copilotClient: CopilotClient
  anthropicPayload: AnthropicMessagesPayload
  anthropicBetaHeader: string | undefined
  selectedModel: Model | undefined
  upstreamSignal: ReturnType<typeof createUpstreamSignalFromConfig>
  headers: Headers
  requestContext: Partial<CapiRequestContext>
  modelMapping: ModelMappingInfo
}

export interface StrategyResult {
  result: ExecutionResult
  modelMapping: ModelMappingInfo
}

export interface StrategyEntry {
  name: string
  canHandle: (model: Model | undefined) => boolean
  execute: (ctx: StrategyContext) => Promise<StrategyResult>
}

export function selectStrategy(
  registry: Array<StrategyEntry>,
  model: Model | undefined,
): StrategyEntry {
  for (const entry of registry) {
    if (entry.canHandle(model)) {
      consola.debug(`Strategy selected: ${entry.name} for model: ${model?.id ?? '(unknown)'}`)
      return entry
    }
  }
  // Should never happen if registry has a fallback, but just in case
  return registry.at(-1)!
}

function filterThinkingBlocksForNativeMessages(
  anthropicPayload: AnthropicMessagesPayload,
) {
  for (const message of anthropicPayload.messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      continue
    }
    message.content = message.content.filter((block) => {
      if (block.type !== 'thinking') {
        return true
      }
      return Boolean(
        block.thinking
        && block.thinking !== 'Thinking...'
        && block.signature
        && !SignatureCodec.isReasoningSignature(block.signature)
        && !SignatureCodec.isCompactionSignature(block.signature),
      )
    })
  }
}

/**
 * Strip `output_config` for models known to reject it, and clamp
 * unsupported effort values to the highest effort the selected model
 * advertises. Copilot rejects unknown effort values before generation.
 */
function sanitizeOutputConfig(
  payload: AnthropicMessagesPayload,
  model: Model | undefined,
): void {
  if (!payload.output_config) {
    return
  }

  if (!modelCache.supportsOutputConfig(model)) {
    delete payload.output_config
    return
  }

  const effort = payload.output_config.effort
  if (effort == null) {
    delete payload.output_config.effort
    if (Object.keys(payload.output_config).length === 0) {
      delete payload.output_config
    }
    return
  }

  const normalizedEffort = normalizeOutputConfigEffort(effort, model)
  if (normalizedEffort) {
    payload.output_config.effort = normalizedEffort
  }
}

const OUTPUT_CONFIG_EFFORTS = ['low', 'medium', 'high', 'max', 'xhigh'] as const
type OutputConfigEffort = typeof OUTPUT_CONFIG_EFFORTS[number]

const OUTPUT_CONFIG_EFFORT_RANK = new Map<OutputConfigEffort, number>(
  OUTPUT_CONFIG_EFFORTS.map((effort, index) => [effort, index]),
)

function isOutputConfigEffort(value: string): value is OutputConfigEffort {
  return OUTPUT_CONFIG_EFFORT_RANK.has(value as OutputConfigEffort)
}

function normalizeOutputConfigEffort(
  effort: OutputConfigEffort,
  model: Model | undefined,
): OutputConfigEffort | undefined {
  const supportedEfforts = model?.capabilities.supports.reasoning_effort
    ?.filter(isOutputConfigEffort)
  if (!supportedEfforts?.length) {
    return undefined
  }

  if (supportedEfforts.includes(effort)) {
    return effort
  }

  return supportedEfforts.reduce((highest, current) => {
    const highestRank = OUTPUT_CONFIG_EFFORT_RANK.get(highest) ?? -1
    const currentRank = OUTPUT_CONFIG_EFFORT_RANK.get(current) ?? -1
    return currentRank > highestRank ? current : highest
  })
}

function normalizeCacheControlBlock(obj: Record<string, unknown>) {
  if (obj.cache_control && typeof obj.cache_control === 'object') {
    obj.cache_control = { type: (obj.cache_control as Record<string, unknown>).type }
  }
}

/**
 * Normalize `cache_control` to strip extra fields (e.g. `scope`) that
 * the upstream Copilot API does not yet accept.
 *
 * Temporary workaround — when Copilot supports `scope`, this filter
 * should be removed. The smoke-cache-control script tests whether the
 * upstream accepts `scope`.
 */
function sanitizeCacheControl(payload: AnthropicMessagesPayload): void {
  if (Array.isArray(payload.system)) {
    for (const block of payload.system) {
      normalizeCacheControlBlock(block as unknown as Record<string, unknown>)
    }
  }

  for (const message of payload.messages) {
    normalizeCacheControlBlock(message as unknown as Record<string, unknown>)
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        normalizeCacheControlBlock(block as unknown as Record<string, unknown>)
      }
    }
  }

  if (payload.tools) {
    for (const tool of payload.tools) {
      normalizeCacheControlBlock(tool as unknown as Record<string, unknown>)
    }
  }
}

const nativeMessagesEntry: StrategyEntry = {
  name: 'native-messages',
  canHandle: model => modelCache.supportsEndpoint(model, MESSAGES_ENDPOINT),
  async execute(ctx) {
    filterThinkingBlocksForNativeMessages(ctx.anthropicPayload)
    sanitizeOutputConfig(ctx.anthropicPayload, ctx.selectedModel)
    sanitizeCacheControl(ctx.anthropicPayload)

    const strategy = createNativeMessagesStrategy(
      ctx.copilotClient,
      ctx.anthropicPayload,
      ctx.anthropicBetaHeader,
      {
        signal: ctx.upstreamSignal.signal,
        requestContext: ctx.requestContext,
      },
    )
    const result = await runStrategy(strategy, ctx.upstreamSignal)
    return { result, modelMapping: ctx.modelMapping }
  },
}

const responsesApiEntry: StrategyEntry = {
  name: 'responses-api',
  canHandle: model => modelCache.supportsEndpoint(model, RESPONSES_ENDPOINT),
  async execute(ctx) {
    const responsesPayload = withTranslationErrors(() =>
      translateAnthropicToResponsesPayload(ctx.anthropicPayload, {
        reasoningEffortResolver: model => configStore.getReasoningEffort(model),
      }),
    )

    applyContextManagement(
      responsesPayload,
      ctx.selectedModel?.capabilities.limits.max_prompt_tokens,
    )
    compactInputByLatestCompaction(responsesPayload)

    const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
    const strategy = createMessagesViaResponsesStrategy(
      ctx.copilotClient,
      responsesPayload,
      {
        vision,
        initiator,
        signal: ctx.upstreamSignal.signal,
        requestContext: ctx.requestContext,
      },
    )
    const result = await runStrategy(strategy, ctx.upstreamSignal)
    return { result, modelMapping: ctx.modelMapping }
  },
}

const chatCompletionsEntry: StrategyEntry = {
  name: 'chat-completions',
  canHandle: () => true,
  async execute(ctx) {
    const adapter = createAnthropicAdapter()
    const plan = withTranslationErrors(() =>
      adapter.toCapiPlan(ctx.anthropicPayload, {
        requestContext: ctx.requestContext,
      }),
    )

    const modelMapping = appendModelStep(ctx.modelMapping, 'MODEL_RESOLVE', plan.resolvedModel)

    consola.debug(
      'Claude Code requested model:',
      ctx.anthropicPayload.model,
      '-> Copilot model:',
      plan.resolvedModel,
    )
    if (consola.level >= 4) {
      consola.debug(
        'Planned Copilot request payload:',
        JSON.stringify(plan.payload),
      )
    }

    const transport = new CopilotTransport(ctx.copilotClient)
    const strategy = createMessagesViaChatCompletionsStrategy(
      transport,
      adapter,
      plan,
      ctx.upstreamSignal.signal,
    )
    const result = await runStrategy(strategy, ctx.upstreamSignal)
    return { result, modelMapping }
  },
}

export const defaultStrategyRegistry: Array<StrategyEntry> = [
  nativeMessagesEntry,
  responsesApiEntry,
  chatCompletionsEntry,
]
