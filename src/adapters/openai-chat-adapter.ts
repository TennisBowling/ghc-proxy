import type {
  CapiChatCompletionChunk,
  CapiChatCompletionResponse,
  CapiExecutionPlan,
  CapiRequestContext,
  CapiResponseMessage,
} from '~/core/capi'
import type {
  CompletionOptions,
  ConversationBlock,
  ConversationRequest,
  ConversationTurn,
  ConversationTurnMeta,
} from '~/core/conversation'
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ChatUsage,
  Message,
  ReasoningDetail,
  ReasoningFormat,
} from '~/types'

import { buildCapiExecutionPlan } from '~/core/capi'
import { throwInvalidRequestError } from '~/lib/error'

interface OpenAIChatAdapterOptions {
  excludeReasoning?: boolean
}

const O_SERIES_MODEL_RE = /^o\d/
const CLAUDE_OPUS_47_RE = /claude.*opus.*4[.-]7/

function toConversationBlocks(
  content: ChatCompletionsPayload['messages'][number]['content'],
): Array<ConversationBlock> {
  if (content === null) {
    return []
  }

  if (typeof content === 'string') {
    return content.length > 0
      ? [{ kind: 'text', text: content }]
      : []
  }

  return content.map((part) => {
    if (part.type === 'text') {
      return {
        kind: 'text',
        text: part.text,
      }
    }

    if (part.type === 'file') {
      throwInvalidRequestError(
        'file content parts require a Copilot model with /responses support. Use a Responses-backed model such as gpt-5.5, or send images with image_url.',
        'messages',
        'unsupported_file_content',
      )
    }

    return {
      kind: 'image',
      url: part.image_url.url,
      detail: part.image_url.detail,
    }
  })
}

function normalizeToolArguments(
  argumentsText: string,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsText) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  }
  catch {
  }

  return {}
}

function getReasoningTextFromDetails(details: Array<ReasoningDetail> | undefined): string | undefined {
  const summary = details?.find(detail => detail.type === 'reasoning.summary')
  if (summary?.type === 'reasoning.summary') {
    return summary.summary
  }

  const text = details?.find(detail => detail.type === 'reasoning.text')
  if (text?.type === 'reasoning.text' && typeof text.text === 'string') {
    return text.text
  }

  return undefined
}

function buildReasoningMeta(message: Message): ConversationTurnMeta | undefined {
  const details = message.reasoning_details
  const reasoningText = message.reasoning ?? message.reasoning_content ?? getReasoningTextFromDetails(details)
  const encrypted = details?.find(detail => detail.type === 'reasoning.encrypted')
  const textWithSignature = details?.find(
    (detail): detail is Extract<ReasoningDetail, { type: 'reasoning.text' }> =>
      detail.type === 'reasoning.text' && typeof detail.signature === 'string' && detail.signature.length > 0,
  )

  const meta: ConversationTurnMeta = {
    ...(reasoningText !== undefined ? { reasoningText } : {}),
    ...(details ? { reasoningDetails: details } : {}),
    ...(encrypted?.type === 'reasoning.encrypted' ? { reasoningOpaque: encrypted.data } : {}),
    ...(textWithSignature?.signature ? { reasoningOpaque: textWithSignature.signature } : {}),
  }

  return Object.keys(meta).length > 0 ? meta : undefined
}

function toConversationTurns(payload: ChatCompletionsPayload): Array<ConversationTurn> {
  return payload.messages.map((message) => {
    const blocks = toConversationBlocks(message.content)

    if (message.role === 'assistant') {
      const toolBlocks = message.tool_calls?.map(toolCall => ({
        kind: 'tool_use' as const,
        id: toolCall.id,
        name: toolCall.function.name,
        input: normalizeToolArguments(toolCall.function.arguments),
        argumentsText: toolCall.function.arguments,
      }))

      return {
        role: 'assistant',
        blocks: [...blocks, ...(toolBlocks ?? [])],
        meta: buildReasoningMeta(message),
      }
    }

    if (message.role === 'tool') {
      return {
        role: 'tool',
        blocks,
        meta: {
          toolCallId: message.tool_call_id,
        },
      }
    }

    return {
      role: message.role,
      blocks,
    }
  })
}

function inferProvider(model: string): string | undefined {
  const normalized = model.toLowerCase()
  if (normalized.includes('claude')) {
    return 'Anthropic'
  }
  if (normalized.includes('gemini')) {
    return 'Google'
  }
  if (normalized.includes('gpt') || O_SERIES_MODEL_RE.test(normalized)) {
    return 'OpenAI'
  }
  if (normalized.includes('grok')) {
    return 'xAI'
  }
  return undefined
}

function isClaude47Model(model: string): boolean {
  const normalized = model.toLowerCase()
  return CLAUDE_OPUS_47_RE.test(normalized)
}

function inferReasoningFormat(model: string): ReasoningFormat {
  const normalized = model.toLowerCase()
  if (normalized.includes('claude')) {
    return 'anthropic-claude-v1'
  }
  if (normalized.includes('gemini')) {
    return 'google-gemini-v1'
  }
  if (normalized.includes('grok')) {
    return 'xai-responses-v1'
  }
  if (normalized.includes('gpt') || O_SERIES_MODEL_RE.test(normalized)) {
    return 'openai-responses-v1'
  }
  return 'unknown'
}

function normalizeUsage(usage: unknown): ChatUsage | undefined {
  if (!usage || typeof usage !== 'object') {
    return undefined
  }

  const raw = usage as Record<string, unknown>
  const promptTokens = typeof raw.prompt_tokens === 'number' ? raw.prompt_tokens : 0
  const completionTokens = typeof raw.completion_tokens === 'number' ? raw.completion_tokens : 0
  const totalTokens = typeof raw.total_tokens === 'number' ? raw.total_tokens : promptTokens + completionTokens
  const rawCompletionDetails = raw.completion_tokens_details && typeof raw.completion_tokens_details === 'object'
    ? raw.completion_tokens_details as Record<string, unknown>
    : undefined
  const reasoningTokens = typeof raw.reasoning_tokens === 'number'
    ? raw.reasoning_tokens
    : typeof rawCompletionDetails?.reasoning_tokens === 'number'
      ? rawCompletionDetails.reasoning_tokens
      : undefined

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    ...(raw.prompt_tokens_details && typeof raw.prompt_tokens_details === 'object'
      ? { prompt_tokens_details: raw.prompt_tokens_details as ChatUsage['prompt_tokens_details'] }
      : {}),
    ...((rawCompletionDetails || reasoningTokens !== undefined)
      ? {
          completion_tokens_details: {
            ...(rawCompletionDetails as ChatUsage['completion_tokens_details'] | undefined),
            ...(reasoningTokens !== undefined ? { reasoning_tokens: reasoningTokens } : {}),
          },
        }
      : {}),
    ...(typeof raw.cost === 'number' || raw.cost === null ? { cost: raw.cost } : {}),
    ...(typeof raw.is_byok === 'boolean' ? { is_byok: raw.is_byok } : {}),
    ...(raw.cost_details && typeof raw.cost_details === 'object'
      ? { cost_details: raw.cost_details as ChatUsage['cost_details'] }
      : {}),
  }
}

function getCapiReasoningText(message: CapiResponseMessage): string | undefined {
  if (typeof message.reasoning === 'string') {
    return message.reasoning
  }
  if (typeof message.reasoning_text === 'string') {
    return message.reasoning_text
  }
  return getReasoningTextFromDetails(message.reasoning_details)
}

function buildReasoningDetailsFromCapi(
  message: CapiResponseMessage,
  model: string,
): Array<ReasoningDetail> | undefined {
  if (message.reasoning_details?.length) {
    return message.reasoning_details
  }

  const format = inferReasoningFormat(model)
  const reasoningText = getCapiReasoningText(message)
  const opaque = message.reasoning_opaque ?? message.encrypted_content ?? undefined
  const details: Array<ReasoningDetail> = []

  if (format === 'openai-responses-v1') {
    if (reasoningText) {
      details.push({
        type: 'reasoning.summary',
        summary: reasoningText,
        format,
        index: details.length,
      })
    }
    if (opaque) {
      details.push({
        type: 'reasoning.encrypted',
        data: opaque,
        format,
        index: details.length,
      })
    }
    return details.length > 0 ? details : undefined
  }

  if (format === 'anthropic-claude-v1') {
    if (reasoningText || opaque) {
      details.push({
        type: 'reasoning.text',
        ...(reasoningText ? { text: reasoningText } : {}),
        ...(opaque ? { signature: opaque } : {}),
        format,
        index: details.length,
      })
    }
    return details.length > 0 ? details : undefined
  }

  if (reasoningText) {
    details.push({
      type: 'reasoning.text',
      text: reasoningText,
      format,
      index: details.length,
    })
  }
  if (opaque) {
    details.push({
      type: 'reasoning.encrypted',
      data: opaque,
      format,
      index: details.length,
    })
  }

  return details.length > 0 ? details : undefined
}

function sanitizeResponse(
  response: CapiChatCompletionResponse,
  options: OpenAIChatAdapterOptions,
): ChatCompletionResponse {
  return {
    id: response.id,
    object: response.object ?? 'chat.completion',
    created: response.created,
    model: response.model,
    ...(inferProvider(response.model) ? { provider: inferProvider(response.model) } : {}),
    system_fingerprint: response.system_fingerprint ?? null,
    usage: normalizeUsage(response.usage),
    choices: response.choices.map((choice) => {
      const reasoning = options.excludeReasoning ? undefined : getCapiReasoningText(choice.message)
      const reasoningDetails = options.excludeReasoning
        ? undefined
        : buildReasoningDetailsFromCapi(choice.message, response.model)

      return {
        index: choice.index,
        finish_reason: choice.finish_reason,
        native_finish_reason: choice.native_finish_reason ?? choice.finish_reason,
        logprobs: choice.logprobs,
        message: {
          role: choice.message.role,
          content: choice.message.content,
          refusal: null,
          ...(reasoning !== undefined ? { reasoning } : {}),
          ...(reasoningDetails ? { reasoning_details: reasoningDetails } : {}),
          ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls } : {}),
        },
      }
    }),
  }
}

function sanitizeChunk(
  chunk: CapiChatCompletionChunk,
  options: OpenAIChatAdapterOptions,
): ChatCompletionChunk {
  return {
    id: chunk.id,
    object: chunk.object ?? 'chat.completion.chunk',
    created: chunk.created,
    model: chunk.model,
    ...(inferProvider(chunk.model) ? { provider: inferProvider(chunk.model) } : {}),
    system_fingerprint: chunk.system_fingerprint ?? undefined,
    usage: normalizeUsage(chunk.usage),
    choices: chunk.choices.map((choice) => {
      const syntheticMessage: CapiResponseMessage = {
        role: 'assistant',
        content: choice.delta.content ?? null,
        reasoning_text: choice.delta.reasoning_text,
        reasoning_opaque: choice.delta.reasoning_opaque,
        encrypted_content: choice.delta.encrypted_content,
        reasoning_details: choice.delta.reasoning_details,
      }
      const reasoning = options.excludeReasoning ? undefined : getCapiReasoningText(syntheticMessage)
      const reasoningDetails = options.excludeReasoning
        ? undefined
        : buildReasoningDetailsFromCapi(syntheticMessage, chunk.model)

      return {
        index: choice.index,
        finish_reason: choice.finish_reason,
        native_finish_reason: choice.native_finish_reason ?? choice.finish_reason,
        logprobs: choice.logprobs,
        delta: {
          ...(choice.delta.role && choice.delta.role !== 'developer'
            ? { role: choice.delta.role }
            : {}),
          content: choice.delta.content,
          ...(reasoning !== undefined ? { reasoning } : {}),
          ...(reasoningDetails ? { reasoning_details: reasoningDetails } : {}),
          ...(choice.delta.tool_calls ? { tool_calls: choice.delta.tool_calls } : {}),
        },
      }
    }),
  }
}

function resolveReasoningEffort(payload: ChatCompletionsPayload) {
  if (payload.reasoning_effort != null) {
    return payload.reasoning_effort
  }
  if (payload.reasoning?.effort != null) {
    return payload.reasoning.effort
  }
  if (payload.include_reasoning === true || payload.reasoning?.enabled === true) {
    return 'medium'
  }
  if (payload.include_reasoning === false) {
    return 'none'
  }
  return undefined
}

function buildCompletionOptions(payload: ChatCompletionsPayload): CompletionOptions | undefined {
  const reasoningEffort = resolveReasoningEffort(payload)
  const opts: CompletionOptions = {
    ...(payload.n != null ? { n: payload.n } : {}),
    ...(payload.frequency_penalty != null ? { frequencyPenalty: payload.frequency_penalty } : {}),
    ...(payload.presence_penalty != null ? { presencePenalty: payload.presence_penalty } : {}),
    ...(payload.logit_bias != null ? { logitBias: payload.logit_bias } : {}),
    ...(payload.logprobs != null ? { logprobs: payload.logprobs } : {}),
    ...(payload.response_format != null ? { responseFormat: payload.response_format } : {}),
    ...(payload.seed != null ? { seed: payload.seed } : {}),
    ...(payload.top_logprobs != null ? { topLogprobs: payload.top_logprobs } : {}),
    ...(payload.parallel_tool_calls != null ? { parallelToolCalls: payload.parallel_tool_calls } : {}),
    ...(payload.verbosity != null ? { verbosity: payload.verbosity } : {}),
    ...(reasoningEffort != null ? { reasoningEffort } : {}),
  }

  return Object.keys(opts).length > 0 ? opts : undefined
}

export class OpenAIChatAdapter {
  private readonly options: OpenAIChatAdapterOptions

  constructor(options: OpenAIChatAdapterOptions = {}) {
    this.options = options
  }

  toConversation(payload: ChatCompletionsPayload): ConversationRequest {
    return {
      model: payload.model,
      turns: toConversationTurns(payload),
      maxTokens: payload.max_completion_tokens ?? payload.max_tokens ?? undefined,
      stopSequences:
        payload.stop == null
          ? undefined
          : Array.isArray(payload.stop)
            ? payload.stop
            : [payload.stop],
      stream: payload.stream ?? undefined,
      temperature: payload.temperature,
      topP: payload.top_p,
      userId: payload.user ?? undefined,
      tools: payload.tools?.map(tool => ({
        name: tool.function.name,
        description: tool.function.description,
        inputSchema: tool.function.parameters,
      })),
      toolChoice:
        payload.tool_choice == null
          ? undefined
          : typeof payload.tool_choice === 'string'
            ? payload.tool_choice === 'required'
              ? { type: 'required' }
              : payload.tool_choice === 'none'
                ? { type: 'none' }
                : { type: 'auto' }
            : 'function' in payload.tool_choice
              ? { type: 'tool', name: payload.tool_choice.function.name }
              : { type: 'auto' },
      thinking:
        payload.thinking_budget != null && !isClaude47Model(payload.model)
          ? { type: 'enabled', budgetTokens: payload.thinking_budget }
          : payload.reasoning?.max_tokens != null && !isClaude47Model(payload.model)
            ? { type: 'enabled', budgetTokens: payload.reasoning.max_tokens }
            : undefined,
      completionOptions: buildCompletionOptions(payload),
    }
  }

  toCapiPlan(
    payload: ChatCompletionsPayload,
    options?: { requestContext?: Partial<CapiRequestContext> },
  ): CapiExecutionPlan {
    return buildCapiExecutionPlan(this.toConversation(payload), {
      requestContext: options?.requestContext,
    })
  }

  toTokenCountPayload(payload: ChatCompletionsPayload) {
    return this.toCapiPlan(payload).tokenCountPayload
  }

  fromCapiResponse(response: CapiChatCompletionResponse): ChatCompletionResponse {
    return sanitizeResponse(response, this.options)
  }

  serializeStreamChunk(chunk: CapiChatCompletionChunk): ChatCompletionChunk {
    return sanitizeChunk(chunk, this.options)
  }
}

export {
  buildReasoningDetailsFromCapi,
  inferProvider,
  inferReasoningFormat,
  normalizeUsage,
  resolveReasoningEffort,
}
