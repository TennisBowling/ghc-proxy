import type { ResponseInputItemsListParams, ResponsesInputTokensPayload } from '~/types'

import { throwInvalidRequestError } from '~/lib/error'
import { createCopilotClient } from '~/lib/state'
import {
  deleteStoredResponseOrThrow,
  estimateEmulatorInputTokens,
  getStoredResponseOrThrow,
  listStoredInputItemsOrThrow,
} from '~/routes/responses/emulator'

import { configStore, modelCache } from '~/state'

export interface ResourceDispatcher {
  retrieve: (responseId: string, params?: Record<string, unknown>) => Promise<unknown>
  listInputItems: (responseId: string, params?: ResponseInputItemsListParams) => Promise<unknown>
  createInputTokens: (payload: ResponsesInputTokensPayload) => Promise<unknown>
  delete: (responseId: string) => Promise<unknown>
}

class EmulatorResourceDispatcher implements ResourceDispatcher {
  retrieve(responseId: string): Promise<unknown> {
    return Promise.resolve(getStoredResponseOrThrow(responseId))
  }

  listInputItems(responseId: string, params?: ResponseInputItemsListParams): Promise<unknown> {
    return Promise.resolve(listStoredInputItemsOrThrow(responseId, params))
  }

  async createInputTokens(payload: ResponsesInputTokensPayload): Promise<unknown> {
    const model = payload.model
    if (!model) {
      throwInvalidRequestError(
        'The selected model could not be resolved.',
        'model',
      )
    }
    const selectedModel = modelCache.findById(model)
    if (!selectedModel) {
      throwInvalidRequestError(
        'The selected model could not be resolved.',
        'model',
      )
    }
    return estimateEmulatorInputTokens(payload, selectedModel)
  }

  delete(responseId: string): Promise<unknown> {
    return Promise.resolve(deleteStoredResponseOrThrow(responseId))
  }
}

class UpstreamResourceDispatcher implements ResourceDispatcher {
  retrieve(responseId: string, params?: Record<string, unknown>): Promise<unknown> {
    const client = createCopilotClient()
    return client.getResponse(responseId, params as Parameters<typeof client.getResponse>[1])
  }

  listInputItems(responseId: string, params?: ResponseInputItemsListParams): Promise<unknown> {
    const client = createCopilotClient()
    return client.getResponseInputItems(responseId, params)
  }

  createInputTokens(payload: ResponsesInputTokensPayload): Promise<unknown> {
    const client = createCopilotClient()
    return client.createResponseInputTokens(payload)
  }

  delete(responseId: string): Promise<unknown> {
    const client = createCopilotClient()
    return client.deleteResponse(responseId)
  }
}

export function createResourceDispatcher(): ResourceDispatcher {
  return configStore.isEmulatorEnabled()
    ? new EmulatorResourceDispatcher()
    : new UpstreamResourceDispatcher()
}
