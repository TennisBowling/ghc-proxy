import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { modelCache } from '~/state'

import { buildGptModel, buildModelsResponse, createApp } from './helpers'

const originalModels = modelCache.getModels()

beforeEach(() => {
  modelCache.clearModels()
})

afterEach(() => {
  if (originalModels !== undefined) {
    modelCache.cacheModels(originalModels)
  }
  else {
    modelCache.clearModels()
  }
})

describe('POST /v1/messages/count_tokens', () => {
  test('accepts payload without max_tokens and returns token count', async () => {
    modelCache.cacheModels(buildModelsResponse(buildGptModel('claude-haiku-4.5')))
    const app = createApp('messages')

    const response = await app.handle(new Request('http://localhost/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4.5',
        messages: [{ role: 'user', content: 'Hello!' }],
      }),
    }))

    expect(response.status).toBe(200)
    const json = (await response.json()) as { input_tokens: number }
    expect(typeof json.input_tokens).toBe('number')
    expect(json.input_tokens).toBeGreaterThan(0)
  })

  test('returns 400 on invalid payload instead of fake success', async () => {
    modelCache.cacheModels(buildModelsResponse(buildGptModel('claude-haiku-4.5')))
    const app = createApp('messages')

    const response = await app.handle(new Request('http://localhost/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4.5',
      }),
    }))

    expect(response.status).toBe(400)
    const json = (await response.json()) as {
      error: { message: string, type: string }
    }
    expect(json.error.message).toContain('Invalid request payload')
  })

  test('GPT model with tools gets higher count than raw tokenizer output', async () => {
    // Test that GPT models receive tool overhead + estimation factor
    // by comparing against a known baseline.
    // Without the fix, GPT models get 0 overhead and 1.0x factor.
    // With the fix, they should get overhead + factor applied.
    modelCache.cacheModels(buildModelsResponse(buildGptModel('gpt-5.4-mini')))
    const app = createApp('messages')

    // Request WITHOUT tools — gives us raw tokenized count
    const noToolsRes = await app.handle(new Request('http://localhost/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'Hello world, this is a test message for token counting.' }],
      }),
    }))
    expect(noToolsRes.status).toBe(200)
    const noToolsJson = (await noToolsRes.json()) as { input_tokens: number }
    const rawCount = noToolsJson.input_tokens

    // Request WITH tools
    const withToolsRes = await app.handle(new Request('http://localhost/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'Hello world, this is a test message for token counting.' }],
        tools: [{ name: 'get_weather', description: 'Get weather', input_schema: { type: 'object', properties: {} } }],
      }),
    }))
    expect(withToolsRes.status).toBe(200)
    const withToolsJson = (await withToolsRes.json()) as { input_tokens: number }

    // The difference should include both tool overhead constant AND estimation factor.
    // Without fix: diff = just tokenizer's tool token count (small, ~20-30 tokens)
    // With fix: diff = tokenizer tool tokens + GPT_TOOL_OVERHEAD_TOKENS (~346) * factor
    // We check that the with-tools count exceeds no-tools by at least 200 tokens,
    // which can only happen if the overhead constant is being added.
    const diff = withToolsJson.input_tokens - rawCount
    expect(diff).toBeGreaterThanOrEqual(200)
  })

  test('returns 400 when model cannot be resolved', async () => {
    modelCache.cacheModels(buildModelsResponse(buildGptModel('gpt-4.1')))
    const app = createApp('messages')

    const response = await app.handle(new Request('http://localhost/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4.5',
        messages: [{ role: 'user', content: 'Hello!' }],
      }),
    }))

    expect(response.status).toBe(400)
    const json = (await response.json()) as {
      error: { message: string, type: string }
    }
    expect(json.error.message).toContain('The selected model could not be resolved')
  })
})
