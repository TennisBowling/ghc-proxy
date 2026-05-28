// Streaming types
export interface ChatUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: {
    cached_tokens: number
    cache_write_tokens?: number
    audio_tokens?: number
    video_tokens?: number
  }
  completion_tokens_details?: {
    accepted_prediction_tokens?: number
    rejected_prediction_tokens?: number
    reasoning_tokens?: number
    audio_tokens?: number
    image_tokens?: number
  }
  cost?: number | null
  is_byok?: boolean
  cost_details?: {
    upstream_inference_cost?: number | null
    upstream_inference_prompt_cost: number
    upstream_inference_completions_cost: number
  } | null
}

export type ChatFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error'

export interface ChatCompletionChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  provider?: string
  choices: Array<Choice>
  system_fingerprint?: string | null
  service_tier?: string | null
  usage?: ChatUsage
  error?: {
    code: string | number
    message: string
  }
}

interface Delta {
  content?: string | null
  reasoning?: string | null
  reasoning_text?: string | null
  reasoning_details?: Array<ReasoningDetail>
  role?: 'user' | 'assistant' | 'system' | 'tool'
  tool_calls?: Array<{
    index: number
    id?: string
    type?: 'function'
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

interface Choice {
  index: number
  delta: Delta
  finish_reason: ChatFinishReason | null
  native_finish_reason?: string | null
  logprobs: object | null
}

// Non-streaming types
export interface ChatCompletionResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  provider?: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string | null
  service_tier?: string | null
  usage?: ChatUsage
}

interface ResponseMessage {
  role: 'assistant'
  content: string | null
  reasoning?: string | null
  reasoning_details?: Array<ReasoningDetail>
  refusal?: string | null
  tool_calls?: Array<ToolCall>
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: ChatFinishReason | null
  native_finish_reason?: string | null
}

export const REASONING_EFFORT_VALUES = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type ReasoningEffort = typeof REASONING_EFFORT_VALUES[number]

export const VERBOSITY_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Verbosity = typeof VERBOSITY_VALUES[number]

// Payload types
export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  max_completion_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null
  stream_options?: {
    include_usage?: boolean | null
  } | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  top_logprobs?: number | null
  response_format?: ResponseFormat | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | 'none'
    | 'auto'
    | 'required'
    | { type: 'function', function: { name: string } }
    | { type: string }
    | null
  parallel_tool_calls?: boolean | null
  user?: string | null
  verbosity?: Verbosity | null
  reasoning?: ChatReasoningConfig | null
  reasoning_effort?: ReasoningEffort | null
  thinking_budget?: number | null
  include_reasoning?: boolean | null
}

export type ResponseFormat
  = | { type: 'text' }
    | { type: 'json_object', [key: string]: unknown }
    | {
      type: 'json_schema'
      json_schema: {
        name: string
        strict?: boolean | null
        schema?: Record<string, unknown>
        description?: string
      }
    }

export interface ChatReasoningConfig {
  effort?: ReasoningEffort | null
  max_tokens?: number | null
  exclude?: boolean | null
  enabled?: boolean | null
  summary?: 'auto' | 'concise' | 'detailed' | null
}

export interface Tool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
    strict?: boolean | null
  }
}

export type ReasoningFormat
  = | 'unknown'
    | 'openai-responses-v1'
    | 'azure-openai-responses-v1'
    | 'xai-responses-v1'
    | 'anthropic-claude-v1'
    | 'google-gemini-v1'

export type ReasoningDetail
  = | {
    type: 'reasoning.summary'
    summary: string
    format?: ReasoningFormat
    id?: string | null
    index?: number
  }
  | {
    type: 'reasoning.text'
    text?: string | null
    signature?: string | null
    format?: ReasoningFormat
    id?: string | null
    index?: number
  }
  | {
    type: 'reasoning.encrypted'
    data: string
    format?: ReasoningFormat
    id?: string | null
    index?: number
  }

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'developer'
  content: string | Array<ContentPart> | null

  name?: string
  reasoning?: string | null
  reasoning_content?: string | null
  reasoning_details?: Array<ReasoningDetail>
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart | FilePart

export interface TextPart {
  type: 'text'
  text: string
}

export interface ImagePart {
  type: 'image_url'
  image_url: {
    url: string
    detail?: 'low' | 'high' | 'auto'
  }
}

export interface FilePart {
  type: 'file'
  file: {
    filename?: string
    file_data?: string
    file_id?: string
  }
}

// Embeddings
export interface EmbeddingRequest {
  input: string | Array<string>
  model: string
  dimensions?: number
  encoding_format?: 'float' | 'base64'
  user?: string
}

export interface Embedding {
  object: string
  embedding: Array<number>
  index: number
}

export interface EmbeddingResponse {
  object: string
  data: Array<Embedding>
  model: string
  usage: {
    prompt_tokens: number
    total_tokens: number
  }
}

// Models
export interface ModelsResponse {
  data: Array<Model>
  object: string
}

interface ModelLimits {
  max_context_window_tokens?: number
  max_output_tokens?: number
  max_prompt_tokens?: number
  max_inputs?: number
  vision?: {
    max_prompt_image_size?: number
    max_prompt_images?: number
    supported_media_types?: Array<string>
  }
}

interface ModelSupports {
  tool_calls?: boolean
  parallel_tool_calls?: boolean
  dimensions?: boolean
  adaptive_thinking?: boolean
  vision?: boolean
  streaming?: boolean
  structured_outputs?: boolean
  reasoning_effort?: Array<string>
}

interface ModelCapabilities {
  family: string
  limits: ModelLimits
  object: string
  supports: ModelSupports
  tokenizer: string
  type: string
}

export interface Model {
  capabilities: ModelCapabilities
  id: string
  model_picker_enabled: boolean
  name: string
  object: string
  preview: boolean
  vendor: string
  version: string
  policy?: {
    state: string
    terms: string
  }
  supported_endpoints?: Array<string>
}
