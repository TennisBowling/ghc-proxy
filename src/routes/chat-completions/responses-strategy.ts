import type { CopilotClient } from '~/clients'
import type { CapiRequestContext } from '~/core/capi'
import type { ExecutionStrategy, SSEOutput, SSEStreamChunk } from '~/lib/execution-strategy'
import type { ChatCompletionsPayload, ResponsesResult } from '~/types'

import consola from 'consola'
import { isAsyncIterable } from '~/lib/async-iterable'
import { passthroughSSEChunk } from '~/lib/execution-strategy'

import {
  chatToResponsesPayload,
  responsesToChatCompletion,
  ResponsesToChatStreamTranslator,
} from './responses-translation'

type ResponsesExecutionResult = Awaited<ReturnType<CopilotClient['createResponses']>>

export function createChatCompletionsViaResponsesStrategy(
  copilotClient: CopilotClient,
  payload: ChatCompletionsPayload,
  options: {
    signal: AbortSignal
    requestContext: Partial<CapiRequestContext>
    vision: boolean
    initiator: 'user' | 'agent'
  },
): ExecutionStrategy<ResponsesExecutionResult, SSEStreamChunk> {
  const responsesPayload = chatToResponsesPayload(payload)
  const streamTranslator = new ResponsesToChatStreamTranslator()
  let sawTerminal = false
  let sawDone = false

  return {
    execute() {
      return copilotClient.createResponses(responsesPayload, {
        signal: options.signal,
        vision: options.vision,
        initiator: options.initiator,
        requestContext: options.requestContext,
      })
    },

    isStream(result): result is ResponsesExecutionResult & AsyncIterable<SSEStreamChunk> {
      return Boolean(payload.stream) && isAsyncIterable(result)
    },

    translateResult(result) {
      consola.debug('Responses-backed chat response:', JSON.stringify(result))
      return responsesToChatCompletion(result as ResponsesResult)
    },

    translateStreamChunk(chunk): SSEOutput | SSEOutput[] | null {
      if (!chunk.data) {
        return null
      }
      if (chunk.data === '[DONE]') {
        sawDone = true
        return passthroughSSEChunk(chunk, '[DONE]')
      }

      const event = JSON.parse(chunk.data)
      const outputs = streamTranslator.onEvent(event)
      if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed' || event.type === 'error') {
        sawTerminal = true
      }
      return outputs.map(output => ({ data: JSON.stringify(output) }))
    },

    onStreamDone() {
      if (sawDone) {
        return null
      }
      if (sawTerminal) {
        return { data: '[DONE]' }
      }
      return [
        { data: JSON.stringify(streamTranslator.onEvent({
          type: 'error',
          sequence_number: 0,
          code: 'stream_ended',
          message: 'Responses stream ended before a terminal event.',
          param: null,
        })[0]) },
        { data: '[DONE]' },
      ]
    },

    onStreamError(error) {
      const message = error instanceof Error ? error.message : 'Responses stream failed.'
      return [
        { data: JSON.stringify(streamTranslator.onEvent({
          type: 'error',
          sequence_number: 0,
          code: 'stream_error',
          message,
          param: null,
        })[0]) },
        { data: '[DONE]' },
      ]
    },
  }
}
