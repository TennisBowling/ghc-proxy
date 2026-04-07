import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ModelMappingInfo } from '~/lib/request-logger'

import type { ResponseFunctionTool, ResponsesPayload, ResponsesResult, ResponseTool } from '~/types'
import { normalizeResponsesRequestContext, resolveInitiator } from '~/core/capi/request-context'
import { shouldUseFunctionApplyPatch, shouldUseResponsesOfficialEmulator } from '~/lib/config'
import { throwInvalidRequestError } from '~/lib/error'
import { runStrategy } from '~/lib/execution-strategy'
import { normalizeFunctionParametersSchemaForCopilot } from '~/lib/function-schema'
import { findModelById, modelSupportsEndpoint, RESPONSES_ENDPOINT } from '~/lib/model-capabilities'
import { applyModelRewrite } from '~/lib/model-rewrite'
import { createCopilotClient } from '~/lib/state'
import { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'
import { parseResponsesPayload } from '~/lib/validation'

import { applyContextManagement, compactInputByLatestCompaction, getResponsesRequestOptions } from './context-management'
import { decorateStoredResponse, persistEmulatorResponse, prepareEmulatorRequest } from './emulator'
import { createResponsesPassthroughStrategy } from './strategy'

const HTTP_URL_RE = /^https?:\/\//i

export interface ResponsesCoreParams {
  body: unknown
  signal: AbortSignal
  headers: Headers
}

export interface ResponsesCoreResult {
  result: ExecutionResult
  modelMapping?: ModelMappingInfo
}

/**
 * Core handler for responses endpoint.
 */
export async function handleResponsesCore(
  { body, signal, headers }: ResponsesCoreParams,
): Promise<ResponsesCoreResult> {
  const payload = parseResponsesPayload(body)
  const requestContext = normalizeResponsesRequestContext(payload, headers)
  const emulatorMode = shouldUseResponsesOfficialEmulator()
  const emulatorPrepared = emulatorMode
    ? prepareEmulatorRequest(payload)
    : undefined

  // Model rewrite (normalize + user rules)
  const rewrite = applyModelRewrite(emulatorPrepared?.upstreamPayload ?? payload)

  const effectivePayload = emulatorPrepared?.upstreamPayload ?? payload

  applyResponsesToolTransforms(effectivePayload)
  applyResponsesInputPolicies(effectivePayload)
  compactInputByLatestCompaction(effectivePayload)

  const selectedModel = findModelById(effectivePayload.model)
  if (!selectedModel) {
    throwInvalidRequestError(
      'The selected model could not be resolved.',
      'model',
    )
  }
  if (!modelSupportsEndpoint(selectedModel, RESPONSES_ENDPOINT)) {
    throwInvalidRequestError(
      'The selected model does not support the responses endpoint.',
      'model',
    )
  }

  applyContextManagement(
    effectivePayload,
    selectedModel.capabilities.limits.max_prompt_tokens,
  )

  const { vision, initiator } = getResponsesRequestOptions(effectivePayload)
  const upstreamSignal = createUpstreamSignalFromConfig(signal)
  const copilotClient = createCopilotClient()
  const decorateResponse = emulatorPrepared
    ? (response: ResponsesResult) => decorateStoredResponse(response, payload, emulatorPrepared)
    : undefined

  const strategy = createResponsesPassthroughStrategy(copilotClient, effectivePayload, {
    vision,
    initiator: resolveInitiator(initiator, requestContext),
    requestContext,
    signal: upstreamSignal.signal,
    mapResponse: decorateResponse,
    onTerminalResponse: emulatorPrepared
      ? (terminalResponse) => {
          if (!emulatorPrepared?.shouldStore) {
            return
          }
          persistEmulatorResponse(
            terminalResponse,
            emulatorPrepared.effectiveInputItems,
          )
        }
      : undefined,
  })

  const result = await runStrategy(strategy, upstreamSignal)

  if (
    emulatorPrepared
    && result.kind === 'json'
  ) {
    const emulatedResponse = decorateStoredResponse(
      result.data as ResponsesResult,
      payload,
      emulatorPrepared,
    )
    if (emulatorPrepared.shouldStore) {
      persistEmulatorResponse(emulatedResponse, emulatorPrepared.effectiveInputItems)
    }
    result.data = emulatedResponse
  }

  const modelMapping: ModelMappingInfo = {
    originalModel: rewrite.originalModel,
    steps: rewrite.reason ? [{ tag: rewrite.reason, result: rewrite.model }] : [],
  }

  return { result, modelMapping }
}

function applyResponsesToolTransforms(payload: ResponsesPayload): void {
  applyFunctionApplyPatch(payload)
  applyFunctionToolCompatibilityDefaults(payload)
  rejectUnsupportedBuiltinTools(payload)
}

function applyFunctionToolCompatibilityDefaults(payload: ResponsesPayload): void {
  if (!Array.isArray(payload.tools)) {
    return
  }

  payload.tools = payload.tools.map((tool) => {
    if (!isResponseFunctionTool(tool)) {
      return tool
    }

    return {
      ...tool,
      parameters: normalizeFunctionParametersSchemaForCopilot(tool.parameters),
      strict: tool.strict ?? true,
    }
  })
}

function isResponseFunctionTool(tool: ResponseTool): tool is ResponseFunctionTool {
  return tool.type === 'function'
}

function applyFunctionApplyPatch(payload: ResponsesPayload): void {
  if (!shouldUseFunctionApplyPatch() || !Array.isArray(payload.tools)) {
    return
  }

  payload.tools = payload.tools.map((tool) => {
    if (
      tool.type === 'custom'
      && typeof tool.name === 'string'
      && tool.name === 'apply_patch'
    ) {
      return {
        type: 'function',
        name: tool.name,
        description: 'Use the `apply_patch` tool to edit files',
        parameters: {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description: 'The entire contents of the apply_patch command',
            },
          },
          required: ['input'],
        },
        strict: false,
      }
    }

    return tool
  })
}

function rejectUnsupportedBuiltinTools(payload: ResponsesPayload): void {
  if (
    payload.tool_choice
    && typeof payload.tool_choice === 'object'
    && 'type' in payload.tool_choice
    && (payload.tool_choice.type === 'web_search_preview'
      || payload.tool_choice.type === 'web_search_preview_2025_03_11')
  ) {
    throwInvalidRequestError(
      'The selected Copilot endpoint does not support the Responses web_search tool.',
      'tool_choice',
      'unsupported_tool_web_search',
    )
  }

  if (!Array.isArray(payload.tools)) {
    return
  }

  for (const tool of payload.tools) {
    if (tool.type === 'web_search') {
      throwInvalidRequestError(
        'The selected Copilot endpoint does not support the Responses web_search tool.',
        'tools',
        'unsupported_tool_web_search',
      )
    }
  }
}

function applyResponsesInputPolicies(payload: ResponsesPayload): void {
  rejectUnsupportedRemoteImageUrls(payload)
}

function rejectUnsupportedRemoteImageUrls(payload: ResponsesPayload): void {
  if (!Array.isArray(payload.input) || !containsRemoteImageUrl(payload.input)) {
    return
  }

  throwInvalidRequestError(
    'The selected Copilot endpoint does not support external image URLs on the Responses API. Use file_id or data URL image input instead.',
    'input',
    'unsupported_input_image_remote_url',
  )
}

function containsRemoteImageUrl(value: unknown): boolean {
  if (!value) {
    return false
  }
  if (Array.isArray(value)) {
    return value.some(entry => containsRemoteImageUrl(entry))
  }
  if (typeof value !== 'object') {
    return false
  }

  const record = value as Record<string, unknown>
  if (
    record.type === 'input_image'
    && typeof record.image_url === 'string'
    && HTTP_URL_RE.test(record.image_url)
  ) {
    return true
  }

  return Object.values(record).some(entry => containsRemoteImageUrl(entry))
}
