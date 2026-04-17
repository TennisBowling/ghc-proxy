import type { ServerSentEventMessage } from 'fetch-event-stream'
import type { ResponseOutputItem, ResponseStreamEvent } from '~/types'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { CopilotClient } from '~/clients'
import { getCachedConfig } from '~/lib/config'
import { authStore, modelCache } from '~/state'

import {
  buildModel,
  buildModelsResponse,
  buildResponsesResult,
  createApp,
  mockResponses,
  parseSse,
  restoreStateSnapshot,
  saveStateSnapshot,
  setupDefaultTestState,
} from './helpers'

interface StreamJsonEvent {
  event: string
  data: Record<string, unknown>
}

const originalCreateResponses = CopilotClient.prototype.createResponses
const stateSnapshot = saveStateSnapshot()
const originalConfig = structuredClone(getCachedConfig())

beforeEach(() => {
  setupDefaultTestState()
  authStore.showToken = false
  authStore.upstreamTimeoutSeconds = undefined

  const config = getCachedConfig()
  for (const key of Object.keys(config)) {
    delete (config as Record<string, unknown>)[key]
  }
})

afterEach(() => {
  CopilotClient.prototype.createResponses = originalCreateResponses
  restoreStateSnapshot(stateSnapshot)

  const config = getCachedConfig()
  for (const key of Object.keys(config)) {
    delete (config as Record<string, unknown>)[key]
  }
  Object.assign(config, structuredClone(originalConfig))
})

function createSseStream(
  chunks: Array<ServerSentEventMessage>,
): AsyncGenerator<ServerSentEventMessage, void, unknown> {
  return (async function* () {
    for (const chunk of chunks) {
      yield chunk
    }
  })()
}

function jsonChunk(event: string, data: unknown): ServerSentEventMessage {
  return {
    event,
    data: JSON.stringify(data),
  }
}

function responseLifecycleChunk(
  type: 'response.created' | 'response.completed' | 'response.incomplete' | 'response.failed',
  sequenceNumber: number,
  overrides: Record<string, unknown> = {},
): ServerSentEventMessage {
  let status: 'in_progress' | 'completed' | 'incomplete' | 'failed' = 'failed'
  if (type === 'response.created') {
    status = 'in_progress'
  }
  else if (type === 'response.completed') {
    status = 'completed'
  }
  else if (type === 'response.incomplete') {
    status = 'incomplete'
  }

  return jsonChunk(type, {
    type,
    sequence_number: sequenceNumber,
    response: buildResponsesResult({
      status,
      ...overrides,
    }),
  } satisfies ResponseStreamEvent)
}

function outputItemChunk(
  type: 'response.output_item.added' | 'response.output_item.done',
  sequenceNumber: number,
  outputIndex: number,
  item: ResponseOutputItem,
): ServerSentEventMessage {
  return jsonChunk(type, {
    type,
    sequence_number: sequenceNumber,
    output_index: outputIndex,
    item,
  } satisfies ResponseStreamEvent)
}

async function collectResponsesStream(chunks: Array<ServerSentEventMessage>): Promise<Array<StreamJsonEvent>> {
  const app = createApp('responses')
  modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5.4', { supported_endpoints: ['/responses'] })))

  CopilotClient.prototype.createResponses = mockResponses(createSseStream(chunks), [])

  const response = await app.handle(new Request('http://localhost/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4',
      stream: true,
      input: [{ type: 'message', role: 'user', content: 'hello' }],
    }),
  }))

  expect(response.status).toBe(200)

  return parseSse(await response.text())
    .filter(event => event.event && event.data)
    .map(event => ({
      event: event.event as string,
      data: JSON.parse(event.data as string) as Record<string, unknown>,
    }))
}

describe('responses stream id normalization', () => {
  test('normalizes item_id-bearing child events independently per output index', async () => {
    const events = await collectResponsesStream([
      responseLifecycleChunk('response.created', 1, { id: 'resp_stable' }),
      outputItemChunk('response.output_item.added', 2, 0, {
        id: 'msg_item_0',
        type: 'message',
        role: 'assistant',
        status: 'in_progress',
        content: [],
      }),
      outputItemChunk('response.output_item.added', 3, 1, {
        id: 'reasoning_item_1',
        type: 'reasoning',
        status: 'in_progress',
        summary: [],
      }),
      jsonChunk('response.content_part.added', {
        type: 'response.content_part.added',
        sequence_number: 4,
        output_index: 0,
        content_index: 0,
        item_id: 'content_part_upstream',
        part: {
          type: 'output_text',
          text: '',
        },
      } satisfies ResponseStreamEvent),
      jsonChunk('response.reasoning_summary_part.added', {
        type: 'response.reasoning_summary_part.added',
        sequence_number: 5,
        output_index: 1,
        summary_index: 0,
        item_id: 'reasoning_part_upstream',
        part: {
          type: 'summary_text',
          text: '',
        },
      } satisfies ResponseStreamEvent),
      jsonChunk('response.some_future_event', {
        type: 'response.some_future_event',
        sequence_number: 6,
        output_index: 1,
        item_id: 'future_upstream',
        metadata: { source: 'test' },
      }),
      jsonChunk('response.content_part.done', {
        type: 'response.content_part.done',
        sequence_number: 7,
        output_index: 0,
        content_index: 0,
        item_id: 'content_done_upstream',
        part: {
          type: 'output_text',
          text: 'done',
        },
      } satisfies ResponseStreamEvent),
      responseLifecycleChunk('response.completed', 8, { id: 'resp_completed_upstream' }),
    ])

    const contentPartAdded = events.find(event => event.event === 'response.content_part.added')
    expect(contentPartAdded?.data.item_id).toBe('msg_item_0')

    const contentPartDone = events.find(event => event.event === 'response.content_part.done')
    expect(contentPartDone?.data.item_id).toBe('msg_item_0')

    const reasoningPartAdded = events.find(event => event.event === 'response.reasoning_summary_part.added')
    expect(reasoningPartAdded?.data.item_id).toBe('reasoning_item_1')

    const futureEvent = events.find(event => event.event === 'response.some_future_event')
    expect(futureEvent?.data.item_id).toBe('reasoning_item_1')

    const completed = events.find(event => event.event === 'response.completed')
    expect((completed?.data.response as Record<string, unknown> | undefined)?.id).toBe('resp_stable')
  })

  test('seeds the stable id from output_item.done when added is missing', async () => {
    const events = await collectResponsesStream([
      responseLifecycleChunk('response.created', 1, { id: 'resp_stable' }),
      outputItemChunk('response.output_item.done', 2, 0, {
        id: 'seed_from_done',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [],
      }),
      jsonChunk('response.output_text.delta', {
        type: 'response.output_text.delta',
        sequence_number: 3,
        output_index: 0,
        content_index: 0,
        item_id: 'late_upstream_child',
        delta: 'hello',
      } satisfies ResponseStreamEvent),
    ])

    const outputItemDone = events.find(event => event.event === 'response.output_item.done')
    expect((outputItemDone?.data.item as Record<string, unknown> | undefined)?.id).toBe('seed_from_done')

    const outputTextDelta = events.find(event => event.event === 'response.output_text.delta')
    expect(outputTextDelta?.data.item_id).toBe('seed_from_done')
  })

  test('does not rewrite child item ids before a stable output item id exists', async () => {
    const events = await collectResponsesStream([
      responseLifecycleChunk('response.created', 1, { id: 'resp_stable' }),
      jsonChunk('response.some_future_event', {
        type: 'response.some_future_event',
        sequence_number: 2,
        output_index: 0,
        item_id: 'upstream_before_seed',
      }),
      outputItemChunk('response.output_item.added', 3, 0, {
        id: 'stable_afterwards',
        type: 'message',
        role: 'assistant',
        status: 'in_progress',
        content: [],
      }),
    ])

    const futureEvent = events.find(event => event.event === 'response.some_future_event')
    expect(futureEvent?.data.item_id).toBe('upstream_before_seed')
  })

  test('stabilizes response ids on incomplete lifecycle events', async () => {
    const events = await collectResponsesStream([
      responseLifecycleChunk('response.created', 1, { id: 'resp_stable' }),
      responseLifecycleChunk('response.incomplete', 2, { id: 'resp_incomplete_upstream' }),
    ])

    const incomplete = events.find(event => event.event === 'response.incomplete')
    expect((incomplete?.data.response as Record<string, unknown> | undefined)?.id).toBe('resp_stable')
  })

  test('stabilizes response ids on failed lifecycle events', async () => {
    const events = await collectResponsesStream([
      responseLifecycleChunk('response.created', 1, { id: 'resp_stable' }),
      responseLifecycleChunk('response.failed', 2, {
        id: 'resp_failed_upstream',
        error: {
          message: 'boom',
        },
      }),
    ])

    const failed = events.find(event => event.event === 'response.failed')
    expect((failed?.data.response as Record<string, unknown> | undefined)?.id).toBe('resp_stable')
  })

  test('passes malformed json chunks through unchanged', async () => {
    const app = createApp('responses')
    modelCache.cacheModels(buildModelsResponse(buildModel('gpt-5.4', { supported_endpoints: ['/responses'] })))

    CopilotClient.prototype.createResponses = mockResponses(createSseStream([
      responseLifecycleChunk('response.created', 1, { id: 'resp_stable' }),
      {
        event: 'response.output_text.delta',
        data: '{not-json}',
      },
    ]), [])

    const response = await app.handle(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        stream: true,
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      }),
    }))

    expect(response.status).toBe(200)

    const body = await response.text()
    expect(body).toContain('event: response.output_text.delta')
    expect(body).toContain('data: {not-json}')
  })
})
