import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ChatUsage,
  Message,
  ReasoningDetail,
  ResponsesPayload,
  ResponsesResult,
  ResponseStreamEvent,
  ResponseTool,
  ToolCall,
} from '~/types'

import { inferProvider, inferReasoningFormat, resolveReasoningEffort } from '~/adapters/openai-chat-adapter'
import { normalizeFunctionParametersSchemaForCopilot } from '~/lib/function-schema'

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function contentToResponsesContent(content: Message['content'], output = false) {
  if (content === null) {
    return output ? [] : ''
  }
  if (typeof content === 'string') {
    return content
  }
  return content.map((part) => {
    if (part.type === 'text') {
      return { type: output ? 'output_text' : 'input_text', text: part.text }
    }
    if (part.type === 'file') {
      return {
        type: 'input_file',
        ...(part.file.filename ? { filename: part.file.filename } : {}),
        ...(part.file.file_data ? { file_data: part.file.file_data } : {}),
        ...(part.file.file_id ? { file_id: part.file.file_id } : {}),
      }
    }
    return {
      type: 'input_image',
      image_url: part.image_url.url,
      ...(part.image_url.detail ? { detail: part.image_url.detail } : {}),
    }
  })
}

function reasoningDetailsToResponsesReasoning(message: Message): Record<string, unknown> | undefined {
  const details = message.reasoning_details
  if (!details?.length && !message.reasoning && !message.reasoning_content) {
    return undefined
  }

  const encrypted = details?.find(detail => detail.type === 'reasoning.encrypted')
  const summary = details?.find(detail => detail.type === 'reasoning.summary')
  const text = details?.find(detail => detail.type === 'reasoning.text')
  const summaryText = summary?.type === 'reasoning.summary'
    ? summary.summary
    : text?.type === 'reasoning.text' && typeof text.text === 'string'
      ? text.text
      : message.reasoning ?? message.reasoning_content ?? ''

  if (!encrypted && !summaryText) {
    return undefined
  }

  return {
    type: 'reasoning',
    ...(encrypted?.type === 'reasoning.encrypted' && encrypted.id ? { id: encrypted.id } : {}),
    ...(summaryText ? { summary: [{ type: 'summary_text', text: summaryText }] } : { summary: [] }),
    ...(encrypted?.type === 'reasoning.encrypted' ? { encrypted_content: encrypted.data } : {}),
  }
}

function chatMessagesToResponsesInput(messages: Array<Message>): NonNullable<ResponsesPayload['input']> {
  const input: Array<Record<string, unknown>> = []

  for (const message of messages) {
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id ?? '',
        output: typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content ?? ''),
        status: 'completed',
      })
      continue
    }

    if (message.role === 'assistant') {
      const reasoning = reasoningDetailsToResponsesReasoning(message)
      if (reasoning) {
        input.push(reasoning)
      }

      if (message.content !== null && message.content !== '') {
        input.push({
          type: 'message',
          role: 'assistant',
          content: contentToResponsesContent(message.content, true),
        })
      }

      for (const toolCall of message.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        })
      }
      continue
    }

    input.push({
      type: 'message',
      role: message.role,
      content: contentToResponsesContent(message.content),
    })
  }

  return input
}

function mapTools(tools: ChatCompletionsPayload['tools']): Array<ResponseTool> | null {
  if (!tools?.length) {
    return null
  }
  return tools.map(tool => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description ?? null,
    parameters: normalizeFunctionParametersSchemaForCopilot(tool.function.parameters),
    strict: tool.function.strict ?? false,
  }))
}

function mapToolChoice(toolChoice: ChatCompletionsPayload['tool_choice']): ResponsesPayload['tool_choice'] {
  if (!toolChoice) {
    return undefined
  }
  if (typeof toolChoice === 'string') {
    return toolChoice
  }
  if ('function' in toolChoice) {
    return { type: 'function', name: toolChoice.function.name }
  }
  return toolChoice as ResponsesPayload['tool_choice']
}

function mapTextConfig(payload: ChatCompletionsPayload): ResponsesPayload['text'] | undefined {
  const format = payload.response_format
  if (!format) {
    return undefined
  }
  if (format.type === 'json_schema') {
    return {
      format: {
        type: 'json_schema',
        name: format.json_schema.name,
        schema: format.json_schema.schema ?? {},
        strict: format.json_schema.strict ?? undefined,
        description: format.json_schema.description ?? undefined,
      },
    }
  }
  return { format: { type: format.type } }
}

function resolveReasoningSummary(payload: ChatCompletionsPayload, effort: ReturnType<typeof resolveReasoningEffort>): 'auto' | 'concise' | 'detailed' | null | undefined {
  if (effort === 'none') {
    return null
  }
  // Copilot /responses only reliably returns reasoning summaries when the
  // summary field is set to "detailed". "auto" and "concise" frequently come
  // back with empty summary arrays. Normalize anything non-null to detailed.
  const requested = payload.reasoning?.summary
  if (requested === null) {
    return null
  }
  return 'detailed'
}

export function chatToResponsesPayload(payload: ChatCompletionsPayload): ResponsesPayload {
  const effort = resolveReasoningEffort(payload)
  const reasoning = effort
    ? {
        effort,
        summary: resolveReasoningSummary(payload, effort),
      }
    : undefined

  return {
    model: payload.model,
    input: chatMessagesToResponsesInput(payload.messages),
    max_output_tokens: payload.max_completion_tokens ?? payload.max_tokens ?? null,
    tools: mapTools(payload.tools),
    tool_choice: mapToolChoice(payload.tool_choice),
    parallel_tool_calls: payload.parallel_tool_calls ?? true,
    stream: payload.stream ?? null,
    store: false,
    user: payload.user ?? null,
    text: mapTextConfig(payload),
    ...(reasoning
      ? {
          reasoning,
          ...(payload.reasoning?.exclude ? {} : { include: ['reasoning.encrypted_content'] }),
        }
      : {}),
    // OpenAI reasoning models behind Copilot /responses reject some chat-style
    // sampling controls. OpenRouter filters provider-unsupported params; do the
    // same here instead of surfacing avoidable upstream 400s. The Anthropic-only
    // verbosity field intentionally does not map to Responses text.verbosity,
    // because OpenRouter documents it as output_config.effort for Claude.
  }
}

function collectOutputText(response: ResponsesResult): string | null {
  const text = response.output_text
  if (text) {
    return text
  }

  let content = ''
  for (const item of response.output) {
    if (item.type !== 'message') {
      continue
    }
    for (const part of item.content ?? []) {
      if (part.type === 'output_text' && typeof part.text === 'string') {
        content += part.text
      }
      else if (part.type === 'refusal' && typeof part.refusal === 'string') {
        content += part.refusal
      }
    }
  }
  return content || null
}

function collectToolCalls(response: ResponsesResult): Array<ToolCall> | undefined {
  const calls = response.output
    .filter((item): item is Extract<ResponsesResult['output'][number], { type: 'function_call' }> => item.type === 'function_call')
    .map((item, index) => ({
      id: item.call_id,
      index,
      type: 'function' as const,
      function: {
        name: item.name,
        arguments: item.arguments,
      },
    }))

  return calls.length > 0 ? calls : undefined
}

function collectReasoning(response: ResponsesResult): { reasoning?: string, details?: Array<ReasoningDetail> } {
  const format = inferReasoningFormat(response.model)
  const details: Array<ReasoningDetail> = []
  let reasoning = ''

  for (const item of response.output) {
    if (item.type !== 'reasoning') {
      continue
    }

    const summary = item.summary
      ?.map(block => block.text ?? '')
      .join('')
      .trim()
      ?? ''
    if (summary) {
      reasoning += summary
      details.push(format === 'openai-responses-v1'
        ? { type: 'reasoning.summary', summary, format, index: details.length }
        : { type: 'reasoning.text', text: summary, format, index: details.length })
    }
    if (item.encrypted_content) {
      details.push({
        type: 'reasoning.encrypted',
        data: item.encrypted_content,
        format,
        id: item.id,
        index: details.length,
      })
    }
  }

  return {
    ...(reasoning ? { reasoning } : {}),
    ...(details.length > 0 ? { details } : {}),
  }
}

function mapResponsesUsage(usage: ResponsesResult['usage']): ChatUsage | undefined {
  if (!usage) {
    return undefined
  }
  const promptTokens = usage.input_tokens ?? 0
  const completionTokens = usage.output_tokens ?? 0
  const cachedTokens = usage.input_tokens_details?.cached_tokens
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage.total_tokens ?? promptTokens + completionTokens,
    ...(usage.input_tokens_details
      ? {
          prompt_tokens_details: {
            cached_tokens: cachedTokens ?? 0,
          },
        }
      : {}),
    ...(usage.output_tokens_details
      ? {
          completion_tokens_details: {
            reasoning_tokens: usage.output_tokens_details.reasoning_tokens,
          },
        }
      : {}),
  }
}

function finishReason(response: ResponsesResult): ChatCompletionResponse['choices'][number]['finish_reason'] {
  if (response.output.some(item => item.type === 'function_call')) {
    return 'tool_calls'
  }
  if (response.status === 'incomplete') {
    if (response.incomplete_details?.reason === 'content_filter') {
      return 'content_filter'
    }
    return 'length'
  }
  if (response.status === 'failed') {
    return 'error'
  }
  return 'stop'
}

export function responsesToChatCompletion(response: ResponsesResult): ChatCompletionResponse {
  const reasoning = collectReasoning(response)
  const provider = inferProvider(response.model)
  return {
    id: response.id,
    object: 'chat.completion',
    created: response.created_at,
    model: response.model,
    ...(provider ? { provider } : {}),
    system_fingerprint: null,
    usage: mapResponsesUsage(response.usage),
    choices: [{
      index: 0,
      finish_reason: finishReason(response),
      native_finish_reason: response.status,
      logprobs: null,
      message: {
        role: 'assistant',
        content: collectOutputText(response),
        refusal: null,
        ...(reasoning.reasoning ? { reasoning: reasoning.reasoning } : {}),
        ...(reasoning.details ? { reasoning_details: reasoning.details } : {}),
        ...(collectToolCalls(response) ? { tool_calls: collectToolCalls(response) } : {}),
      },
    }],
  }
}

interface ResponsesStreamState {
  id?: string
  model?: string
  created?: number
  sawReasoningText: boolean
  textDeltaKeys: Set<string>
  functionArgumentDeltaOutputIndexes: Set<number>
  functionNamesByOutputIndex: Map<number, string>
  functionCallIdsByOutputIndex: Map<number, string>
}

export class ResponsesToChatStreamTranslator {
  private readonly state: ResponsesStreamState = {
    sawReasoningText: false,
    textDeltaKeys: new Set(),
    functionArgumentDeltaOutputIndexes: new Set(),
    functionNamesByOutputIndex: new Map(),
    functionCallIdsByOutputIndex: new Map(),
  }

  onEvent(event: ResponseStreamEvent): Array<ChatCompletionChunk> {
    switch (event.type) {
      case 'response.created':
        this.state.id = event.response.id
        this.state.model = event.response.model
        this.state.created = event.response.created_at
        return []
      case 'response.reasoning_summary_text.delta':
        this.state.sawReasoningText = true
        return [this.chunk({
          reasoning: event.delta,
          reasoning_details: [{
            type: inferReasoningFormat(this.model()) === 'openai-responses-v1' ? 'reasoning.summary' : 'reasoning.text',
            ...(inferReasoningFormat(this.model()) === 'openai-responses-v1'
              ? { summary: event.delta }
              : { text: event.delta }),
            format: inferReasoningFormat(this.model()),
            index: 0,
          } as ReasoningDetail],
        })]
      case 'response.reasoning_summary_text.done':
        if (!event.text || this.state.sawReasoningText) {
          return []
        }
        this.state.sawReasoningText = true
        return [this.chunk({
          reasoning: event.text,
          reasoning_details: [{
            type: inferReasoningFormat(this.model()) === 'openai-responses-v1' ? 'reasoning.summary' : 'reasoning.text',
            ...(inferReasoningFormat(this.model()) === 'openai-responses-v1'
              ? { summary: event.text }
              : { text: event.text }),
            format: inferReasoningFormat(this.model()),
            index: 0,
          } as ReasoningDetail],
        })]
      case 'response.output_text.delta':
        this.state.textDeltaKeys.add(`${event.output_index}:${event.content_index}`)
        return [this.chunk({ content: event.delta })]
      case 'response.output_text.done':
        return event.text && !this.state.textDeltaKeys.has(`${event.output_index}:${event.content_index}`)
          ? [this.chunk({ content: event.text })]
          : []
      case 'response.output_item.added':
        if (event.item.type !== 'function_call') {
          return []
        }
        this.state.functionCallIdsByOutputIndex.set(event.output_index, event.item.call_id)
        this.state.functionNamesByOutputIndex.set(event.output_index, event.item.name)
        if (event.item.arguments) {
          this.state.functionArgumentDeltaOutputIndexes.add(event.output_index)
        }
        return [this.chunk({
          tool_calls: [{
            index: event.output_index,
            id: event.item.call_id,
            type: 'function',
            function: { name: event.item.name, arguments: event.item.arguments ?? '' },
          }],
        })]
      case 'response.function_call_arguments.delta':
        this.state.functionArgumentDeltaOutputIndexes.add(event.output_index)
        return [this.chunk({
          tool_calls: [{
            index: event.output_index,
            id: this.state.functionCallIdsByOutputIndex.get(event.output_index),
            type: 'function',
            function: {
              name: this.state.functionNamesByOutputIndex.get(event.output_index),
              arguments: event.delta,
            },
          }],
        })]
      case 'response.function_call_arguments.done':
        return event.arguments && !this.state.functionArgumentDeltaOutputIndexes.has(event.output_index)
          ? [this.chunk({
              tool_calls: [{
                index: event.output_index,
                id: this.state.functionCallIdsByOutputIndex.get(event.output_index),
                type: 'function',
                function: {
                  name: event.name ?? this.state.functionNamesByOutputIndex.get(event.output_index),
                  arguments: event.arguments,
                },
              }],
            })]
          : []
      case 'response.output_item.done':
        if (event.item.type === 'reasoning' && event.item.encrypted_content) {
          return [this.chunk({
            reasoning_details: [{
              type: 'reasoning.encrypted',
              data: event.item.encrypted_content,
              format: inferReasoningFormat(this.model()),
              id: event.item.id,
              index: this.state.sawReasoningText ? 1 : 0,
            }],
          })]
        }
        return []
      case 'response.completed':
      case 'response.incomplete':
        return [this.terminalChunk(event.response)]
      case 'response.failed':
        return [this.errorChunk(event.response.error?.message ?? 'The response failed.')]
      case 'error':
        return [this.errorChunk(event.message)]
      default:
        return []
    }
  }

  private model(): string {
    return this.state.model ?? 'unknown'
  }

  private chunk(delta: ChatCompletionChunk['choices'][number]['delta']): ChatCompletionChunk {
    const model = this.model()
    const provider = inferProvider(model)
    return {
      id: this.state.id ?? 'chatcmpl_unknown',
      object: 'chat.completion.chunk',
      created: this.state.created ?? nowSeconds(),
      model,
      ...(provider ? { provider } : {}),
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          ...delta,
        },
        finish_reason: null,
        native_finish_reason: null,
        logprobs: null,
      }],
    }
  }

  private terminalChunk(response: ResponsesResult): ChatCompletionChunk {
    const provider = inferProvider(response.model)
    return {
      id: response.id,
      object: 'chat.completion.chunk',
      created: response.created_at,
      model: response.model,
      ...(provider ? { provider } : {}),
      usage: mapResponsesUsage(response.usage),
      choices: [{
        index: 0,
        delta: { content: '', role: 'assistant' },
        finish_reason: finishReason(response),
        native_finish_reason: response.status,
        logprobs: null,
      }],
    }
  }

  private errorChunk(message: string): ChatCompletionChunk {
    const model = this.model()
    const provider = inferProvider(model)
    return {
      id: this.state.id ?? 'chatcmpl_error',
      object: 'chat.completion.chunk',
      created: this.state.created ?? nowSeconds(),
      model,
      ...(provider ? { provider } : {}),
      error: { code: 'server_error', message },
      choices: [{
        index: 0,
        delta: { content: '' },
        finish_reason: 'error',
        native_finish_reason: 'error',
        logprobs: null,
      }],
    }
  }
}
