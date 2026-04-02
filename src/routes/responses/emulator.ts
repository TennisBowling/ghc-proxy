import type {
  Model,
  ResponseConversation,
  ResponseInputItem,
  ResponseInputItemsListParams,
  ResponseInputItemsListResult,
  ResponseInputText,
  ResponseInputTokensResult,
  ResponseOutputCompaction,
  ResponseOutputFunctionCall,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseOutputReasoning,
  ResponsesInputTokensPayload,
  ResponsesPayload,
  ResponsesResult,
} from '~/types'

import { randomUUID } from 'node:crypto'

import { HTTPError, throwInvalidRequestError } from '~/lib/error'
import { state } from '~/lib/state'
import { estimateResponsesInputTokens } from '~/lib/tokenizer'

function cloneValue<T>(value: T): T {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value)
  }
  return JSON.parse(JSON.stringify(value)) as T
}

export interface PreparedEmulatorRequest {
  upstreamPayload: ResponsesPayload
  effectiveInputItems: Array<ResponseInputItem>
  previousResponseId?: string
  conversation?: ResponseConversation
  shouldStore: boolean
}

interface ResponsesContinuationPayload {
  conversation?: ResponseConversation | null
  previous_response_id?: string | null
}

interface BackgroundCapablePayload {
  background?: boolean | null
}

export function rejectUnsupportedBackground(payload: BackgroundCapablePayload): void {
  if (payload.background) {
    throwInvalidRequestError(
      'background mode is not supported by the responses official emulator.',
      'background',
      'unsupported_background_mode',
    )
  }
}

export function prepareEmulatorRequest(payload: ResponsesPayload): PreparedEmulatorRequest {
  rejectUnsupportedBackground(payload)

  const normalizedCurrentInput = normalizeResponsesInput(payload.input)
  const {
    continuationSourceResponseId,
    conversation,
    previousResponse,
  } = resolveContinuation(payload)
  const continuationHistory = continuationSourceResponseId
    ? buildContinuationHistory(continuationSourceResponseId)
    : []
  const effectiveInputItems = [...continuationHistory, ...normalizedCurrentInput]
  const shouldStore = payload.store ?? true

  const upstreamPayload: ResponsesPayload = {
    ...payload,
    background: undefined,
    conversation: undefined,
    previous_response_id: undefined,
    store: undefined,
    input: effectiveInputItems,
  }

  return {
    upstreamPayload,
    effectiveInputItems,
    previousResponseId: previousResponse?.id,
    conversation,
    shouldStore,
  }
}

export function decorateStoredResponse(
  upstreamResponse: ResponsesResult,
  requestPayload: ResponsesPayload,
  prepared: PreparedEmulatorRequest,
): ResponsesResult {
  const conversation = prepared.conversation ?? createConversationRef()

  return {
    ...cloneValue(upstreamResponse),
    previous_response_id: prepared.previousResponseId ?? null,
    conversation,
    truncation: requestPayload.truncation ?? null,
    store: prepared.shouldStore,
    user: normalizeNullableString(requestPayload.user),
    service_tier: normalizeServiceTier(requestPayload.service_tier),
  }
}

export function persistEmulatorResponse(
  response: ResponsesResult,
  effectiveInputItems: Array<ResponseInputItem>,
): void {
  state.responsesEmulator.setResponse(response)
  if (response.conversation) {
    state.responsesEmulator.setConversation(response.conversation)
    state.responsesEmulator.setConversationHead(
      getConversationId(response.conversation),
      response.id,
    )
  }
  state.responsesEmulator.setInputItems(response.id, effectiveInputItems)
}

export function getStoredResponseOrThrow(responseId: string): ResponsesResult {
  const response = state.responsesEmulator.getResponse(responseId)
  if (!response) {
    throw new HTTPError(404, {
      error: {
        message: `No response found with id '${responseId}'.`,
        type: 'invalid_request_error',
      },
    })
  }
  return response
}

export function listStoredInputItemsOrThrow(
  responseId: string,
  params?: ResponseInputItemsListParams,
): ResponseInputItemsListResult {
  const items = state.responsesEmulator.getInputItems(responseId)
  if (!items) {
    throw new HTTPError(404, {
      error: {
        message: `No response input items found for id '${responseId}'.`,
        type: 'invalid_request_error',
      },
    })
  }

  let orderedItems = cloneValue(items)

  if (params?.after) {
    const afterIndex = orderedItems.findIndex(item => getInputItemId(item) === params.after)
    if (afterIndex >= 0) {
      orderedItems = orderedItems.slice(afterIndex + 1)
    }
  }

  if (params?.order === 'desc') {
    orderedItems.reverse()
  }

  const limitedItems = orderedItems.slice(0, params?.limit ?? orderedItems.length)
  return {
    object: 'list',
    data: limitedItems,
    first_id: getInputItemId(limitedItems[0]) ?? null,
    last_id: getInputItemId(limitedItems.at(-1)) ?? null,
    has_more: limitedItems.length < orderedItems.length,
  }
}

export function deleteStoredResponseOrThrow(responseId: string) {
  getStoredResponseOrThrow(responseId)
  return state.responsesEmulator.deleteResponse(responseId)
}

export async function estimateEmulatorInputTokens(
  payload: ResponsesInputTokensPayload,
  selectedModel: Model,
): Promise<ResponseInputTokensResult> {
  rejectUnsupportedBackground(payload)
  const effectiveInputItems = resolveEffectiveInputForInputTokens(payload)
  const inputTokens = await estimateResponsesInputTokens(effectiveInputItems, selectedModel)
  return {
    object: 'response.input_tokens',
    input_tokens: inputTokens,
  }
}

function resolveEffectiveInputForInputTokens(
  payload: ResponsesInputTokensPayload,
): Array<ResponseInputItem> {
  const normalizedInput = normalizeResponsesInput(payload.input)
  const { continuationSourceResponseId } = resolveContinuation(payload)
  if (continuationSourceResponseId) {
    return [
      ...buildContinuationHistory(continuationSourceResponseId),
      ...normalizedInput,
    ]
  }

  return normalizedInput
}

function resolveContinuation(
  payload: ResponsesContinuationPayload,
): {
  continuationSourceResponseId?: string
  conversation?: ResponseConversation
  previousResponse?: ResponsesResult
} {
  const previousResponse = resolvePreviousResponse(payload.previous_response_id)
  const conversation = resolveConversation(payload.conversation, previousResponse)
  return {
    previousResponse,
    conversation,
    continuationSourceResponseId: resolveContinuationSourceResponseId(previousResponse, conversation),
  }
}

function resolvePreviousResponse(
  previousResponseId?: string | null,
): ResponsesResult | undefined {
  if (typeof previousResponseId !== 'string' || previousResponseId.length === 0) {
    return undefined
  }

  const previousResponse = state.responsesEmulator.getResponse(previousResponseId)
  if (!previousResponse) {
    throwInvalidRequestError(
      'The selected previous_response_id could not be resolved.',
      'previous_response_id',
    )
  }

  return previousResponse
}

function resolveConversation(
  conversation?: ResponseConversation | null,
  previousResponse?: ResponsesResult,
): ResponseConversation | undefined {
  if (isConversationReference(conversation)) {
    const conversationId = getConversationId(conversation)
    const existingConversation = state.responsesEmulator.getConversation(conversationId)
    if (!existingConversation) {
      throwInvalidRequestError(
        'The selected conversation could not be resolved.',
        'conversation',
      )
    }
    if (
      previousResponse?.conversation
      && getConversationId(previousResponse.conversation) !== conversationId
    ) {
      throwInvalidRequestError(
        'The selected previous_response_id does not belong to the selected conversation.',
        'previous_response_id',
      )
    }
    return existingConversation
  }

  return previousResponse?.conversation ?? undefined
}

function resolveContinuationSourceResponseId(
  previousResponse?: ResponsesResult,
  conversation?: ResponseConversation,
): string | undefined {
  if (previousResponse) {
    return previousResponse.id
  }

  if (!conversation) {
    return undefined
  }

  const head = state.responsesEmulator.getConversationHead(getConversationId(conversation))
  if (!head) {
    throwInvalidRequestError(
      'The selected conversation could not be resolved.',
      'conversation',
    )
  }

  return head
}

function buildContinuationHistory(responseId: string): Array<ResponseInputItem> {
  const previousResponse = getStoredResponseOrThrow(responseId)
  const previousInput = state.responsesEmulator.getInputItems(responseId)
  if (!previousInput) {
    throwInvalidRequestError(
      'The selected previous_response_id is missing stored input items.',
      'previous_response_id',
    )
  }

  return [
    ...cloneValue(previousInput),
    ...convertOutputItemsToInputItems(previousResponse.output),
  ]
}

function normalizeResponsesInput(
  input: ResponsesPayload['input'] | ResponsesInputTokensPayload['input'],
): Array<ResponseInputItem> {
  if (!input) {
    return []
  }
  if (typeof input === 'string') {
    return [{
      type: 'message',
      role: 'user',
      content: input,
    }]
  }
  if (Array.isArray(input)) {
    return cloneValue(input)
  }
  return []
}

function convertOutputItemsToInputItems(
  output: Array<ResponseOutputItem>,
): Array<ResponseInputItem> {
  const items: Array<ResponseInputItem> = []

  for (const item of output) {
    switch (item.type) {
      case 'message':
        items.push(convertMessageOutputToInput(item))
        break
      case 'function_call':
        items.push(convertFunctionCallOutputToInput(item))
        break
      case 'reasoning': {
        const reasoningInput = convertReasoningOutputToInput(item)
        if (reasoningInput) {
          items.push(reasoningInput)
        }
        break
      }
      case 'compaction':
        items.push(convertCompactionOutputToInput(item))
        break
    }
  }

  return items
}

function convertMessageOutputToInput(
  item: ResponseOutputMessage,
): ResponseInputItem {
  return {
    type: 'message',
    role: item.role,
    status: item.status,
    content: item.content?.map((content) => {
      if (content.type === 'output_text' && typeof content.text === 'string') {
        return {
          type: 'output_text',
          text: content.text,
        } satisfies ResponseInputText
      }
      return cloneValue(content)
    }) ?? [],
  }
}

function convertFunctionCallOutputToInput(
  item: ResponseOutputFunctionCall,
): ResponseInputItem {
  return {
    type: 'function_call',
    call_id: item.call_id,
    name: item.name,
    arguments: item.arguments,
    status: item.status,
  }
}

function convertReasoningOutputToInput(
  item: ResponseOutputReasoning,
): ResponseInputItem | undefined {
  if (!item.encrypted_content) {
    return undefined
  }

  return {
    id: item.id,
    type: 'reasoning',
    summary: (item.summary ?? [])
      .filter(summary => typeof summary.text === 'string')
      .map(summary => ({
        type: 'summary_text',
        text: summary.text as string,
      })),
    encrypted_content: item.encrypted_content,
  }
}

function convertCompactionOutputToInput(
  item: ResponseOutputCompaction,
): ResponseInputItem {
  return {
    id: item.id,
    type: 'compaction',
    encrypted_content: item.encrypted_content,
  }
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function normalizeServiceTier(
  value: unknown,
): ResponsesResult['service_tier'] {
  if (
    value === 'auto'
    || value === 'default'
    || value === 'flex'
    || value === 'scale'
    || value === 'priority'
  ) {
    return value
  }
  return null
}

function createConversationRef(): ResponseConversation {
  return {
    id: `conv_${randomUUID().replaceAll('-', '')}`,
  }
}

function isConversationReference(value: unknown): value is ResponseConversation {
  if (typeof value === 'string') {
    return value.length > 0
  }
  return typeof value === 'object'
    && value !== null
    && 'id' in value
    && typeof value.id === 'string'
    && value.id.length > 0
}

function getConversationId(conversation: ResponseConversation): string {
  return typeof conversation === 'string'
    ? conversation
    : conversation.id
}

function getInputItemId(item: ResponseInputItem | undefined): string | undefined {
  if (!item || typeof item !== 'object') {
    return undefined
  }

  if ('id' in item && typeof item.id === 'string') {
    return item.id
  }
  if ('call_id' in item && typeof item.call_id === 'string') {
    return item.call_id
  }

  return undefined
}
