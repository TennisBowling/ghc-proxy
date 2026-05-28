import type { ChatCompletionsPayload } from '~/types'

import { z } from 'zod'

import { REASONING_EFFORT_VALUES } from '~/types'

import {
  createObjectSchemaDefinitionSchema,
  finiteNumberSchema,
  nonNegativeIntegerSchema,
  parsePayload,
} from './shared'

const VERBOSITY_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const

// ── Schema Definitions ──

const openAIPenaltySchema = finiteNumberSchema.min(-2).max(2)
const openAILogitBiasKeySchema = z.string().regex(/^\d+$/)
const openAILogitBiasValueSchema = finiteNumberSchema.min(-100).max(100)

const openAITextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
}).loose()

const openAIImagePartSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string(),
    detail: z.enum(['low', 'high', 'auto']).optional(),
  }).loose(),
}).loose()

const openAIFilePartSchema = z.object({
  type: z.literal('file'),
  file: z.object({
    filename: z.string().optional(),
    file_data: z.string().optional(),
    file_id: z.string().optional(),
  }).loose(),
}).loose().superRefine((part, ctx) => {
  if (!part.file.file_data && !part.file.file_id) {
    ctx.addIssue({
      code: 'custom',
      message: 'file content requires file_data or file_id',
      path: ['file'],
    })
  }
})

const openAIContentSchema = z.union([
  z.string(),
  z.null(),
  z.array(z.union([openAITextPartSchema, openAIImagePartSchema, openAIFilePartSchema])),
])

const reasoningFormatSchema = z.enum([
  'unknown',
  'openai-responses-v1',
  'azure-openai-responses-v1',
  'xai-responses-v1',
  'anthropic-claude-v1',
  'google-gemini-v1',
])

const reasoningDetailSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('reasoning.summary'),
    summary: z.string(),
    format: reasoningFormatSchema.optional(),
    id: z.string().nullable().optional(),
    index: z.number().int().nonnegative().optional(),
  }).loose(),
  z.object({
    type: z.literal('reasoning.text'),
    text: z.string().nullable().optional(),
    signature: z.string().nullable().optional(),
    format: reasoningFormatSchema.optional(),
    id: z.string().nullable().optional(),
    index: z.number().int().nonnegative().optional(),
  }).loose(),
  z.object({
    type: z.literal('reasoning.encrypted'),
    data: z.string(),
    format: reasoningFormatSchema.optional(),
    id: z.string().nullable().optional(),
    index: z.number().int().nonnegative().optional(),
  }).loose(),
])

const openAIToolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string(),
  }).loose(),
}).loose()

const openAIMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool', 'developer']),
  content: openAIContentSchema,
  name: z.string().optional(),
  reasoning: z.string().nullable().optional(),
  reasoning_content: z.string().nullable().optional(),
  reasoning_details: z.array(reasoningDetailSchema).optional(),
  tool_calls: z.array(openAIToolCallSchema).optional(),
  tool_call_id: z.string().optional(),
}).loose().superRefine((message, ctx) => {
  if (message.role === 'tool' && !message.tool_call_id) {
    ctx.addIssue({
      code: 'custom',
      message: 'tool messages require tool_call_id',
      path: ['tool_call_id'],
    })
  }

  if (message.role !== 'assistant' && message.tool_calls) {
    ctx.addIssue({
      code: 'custom',
      message: 'tool_calls are only valid on assistant messages',
      path: ['tool_calls'],
    })
  }
})

const openAIToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: createObjectSchemaDefinitionSchema('tool function.parameters must describe an object'),
    strict: z.boolean().nullable().optional(),
  }).loose(),
}).loose()

const openAIToolChoiceSchema = z.union([
  z.literal('none'),
  z.literal('auto'),
  z.literal('required'),
  z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string().min(1),
    }).loose(),
  }).loose(),
  z.object({
    type: z.string().min(1),
  }).loose(),
])

const openAIResponseFormatSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text') }).loose(),
  z.object({ type: z.literal('json_object') }).loose(),
  z.object({
    type: z.literal('json_schema'),
    json_schema: z.object({
      name: z.string().min(1),
      strict: z.boolean().nullable().optional(),
      schema: z.record(z.string(), z.unknown()).optional(),
      description: z.string().optional(),
    }).loose(),
  }).loose(),
])

const openAIReasoningConfigSchema = z.object({
  effort: z.enum(REASONING_EFFORT_VALUES).nullable().optional(),
  max_tokens: z.number().int().positive().nullable().optional(),
  exclude: z.boolean().nullable().optional(),
  enabled: z.boolean().nullable().optional(),
  summary: z.enum(['auto', 'concise', 'detailed']).nullable().optional(),
}).loose()

const openAIChatPayloadSchema = z.object({
  model: z.string().min(1),
  messages: z.array(openAIMessageSchema).min(1),
  temperature: finiteNumberSchema.min(0).max(2).nullable().optional(),
  top_p: finiteNumberSchema.min(0).max(1).nullable().optional(),
  max_tokens: nonNegativeIntegerSchema.nullable().optional(),
  max_completion_tokens: nonNegativeIntegerSchema.nullable().optional(),
  stop: z.union([z.string(), z.array(z.string())]).nullable().optional(),
  n: z.number().int().positive().nullable().optional(),
  stream: z.boolean().nullable().optional(),
  stream_options: z.object({
    include_usage: z.boolean().nullable().optional(),
  }).loose().nullable().optional(),
  frequency_penalty: openAIPenaltySchema.nullable().optional(),
  presence_penalty: openAIPenaltySchema.nullable().optional(),
  logit_bias: z.record(openAILogitBiasKeySchema, openAILogitBiasValueSchema).nullable().optional(),
  logprobs: z.boolean().nullable().optional(),
  top_logprobs: z.number().int().min(0).max(20).nullable().optional(),
  response_format: openAIResponseFormatSchema.nullable().optional(),
  seed: z.number().int().nullable().optional(),
  tools: z.array(openAIToolSchema).nullable().optional(),
  tool_choice: openAIToolChoiceSchema.nullable().optional(),
  parallel_tool_calls: z.boolean().nullable().optional(),
  user: z.string().nullable().optional(),
  verbosity: z.enum(VERBOSITY_VALUES).nullable().optional(),
  reasoning: openAIReasoningConfigSchema.nullable().optional(),
  reasoning_effort: z.enum(REASONING_EFFORT_VALUES).nullable().optional(),
  thinking_budget: z.number().int().positive().nullable().optional(),
  include_reasoning: z.boolean().nullable().optional(),
}).loose().superRefine((payload, ctx) => {
  const toolChoice = payload.tool_choice
  const toolChoiceFunctionName = toolChoice
    && typeof toolChoice === 'object'
    && 'function' in toolChoice
    && toolChoice.function
    && typeof toolChoice.function === 'object'
    && 'name' in toolChoice.function
    && typeof toolChoice.function.name === 'string'
    ? toolChoice.function.name
    : undefined

  if (toolChoice && typeof toolChoice === 'object' && 'type' in toolChoice && toolChoice.type !== 'function') {
    ctx.addIssue({
      code: 'custom',
      message: 'server tool_choice objects are not supported by this proxy',
      path: ['tool_choice', 'type'],
    })
  }

  if (toolChoice && typeof toolChoice === 'object' && 'type' in toolChoice && toolChoice.type === 'function' && !toolChoiceFunctionName) {
    ctx.addIssue({
      code: 'custom',
      message: 'tool_choice.function.name is required for function tool choices',
      path: ['tool_choice', 'function', 'name'],
    })
  }

  if (
    toolChoiceFunctionName
    && !payload.tools?.some(tool => tool.function.name === toolChoiceFunctionName)
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'tool_choice.function.name must reference a declared tool',
      path: ['tool_choice', 'function', 'name'],
    })
  }
})

// ── Parse Function ──

export function parseOpenAIChatPayload(payload: unknown): ChatCompletionsPayload {
  const parsed = parsePayload(openAIChatPayloadSchema, 'openai.chat', payload) as ChatCompletionsPayload
  if (parsed.reasoning?.effort != null && parsed.reasoning.enabled == null) {
    parsed.reasoning.enabled = parsed.reasoning.effort !== 'none'
  }
  return parsed
}
