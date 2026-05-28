import os from 'node:os'
import { beforeEach, describe, expect, mock, test } from 'bun:test'

import { HTTPError } from '../src/lib/error'

const mockConsola = {
  info: mock(() => {}),
  debug: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
}

await mock.module('consola', () => ({
  default: mockConsola,
}))

await mock.module('node:os', () => ({
  ...os,
  homedir: () => '/tmp/ghc-proxy-test-retry',
}))

await mock.module('../src/clients/vscode-client', () => ({
  getVSCodeVersion: mock(() => Promise.resolve('1.91.0')),
}))

const sleepMock = mock((_ms: number) => Promise.resolve())
await mock.module('../src/lib/sleep', () => ({
  sleep: sleepMock,
}))

const getCopilotTokenMock = mock(() =>
  Promise.resolve({ token: 'test-token', refresh_in: 1800 }),
)

function okJson(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
  const url = String(input)
  if (url.endsWith('/copilot_internal/v2/token')) {
    return okJson(await getCopilotTokenMock())
  }

  return new Response(`Unexpected test URL: ${url}`, { status: 404 })
})

const { GitHubClient } = await import('../src/clients/github-client')
const { refreshCopilotToken } = await import('../src/lib/token')
const { authStore, modelCache } = await import('../src/state')

describe('refreshCopilotToken', () => {
  beforeEach(() => {
    getCopilotTokenMock.mockClear()
    fetchMock.mockClear()
    sleepMock.mockClear()
    mockConsola.debug.mockClear()
    mockConsola.warn.mockClear()
    mockConsola.error.mockClear()
    mockConsola.info.mockClear()

    authStore.githubToken = undefined
    authStore.copilotToken = undefined
    authStore.copilotApiBase = undefined
    authStore.gheDomain = undefined
    authStore.githubLogin = undefined
    authStore.accountType = 'individual'
    authStore.manualApprove = false
    authStore.rateLimitWait = false
    authStore.showToken = false
    authStore.rateLimitSeconds = undefined
    authStore.upstreamTimeoutSeconds = undefined
    modelCache.clearModels()
    modelCache.clearVSCodeVersion()
  })

  function createClient() {
    return new GitHubClient(authStore, { accountType: 'individual' }, { fetch: fetchMock as unknown as typeof fetch })
  }

  test('successful refresh updates state', async () => {
    getCopilotTokenMock.mockImplementation(() =>
      Promise.resolve({ token: 'refreshed-token', refresh_in: 1800 }),
    )

    await refreshCopilotToken(createClient())

    expect(authStore.copilotToken).toBe('refreshed-token')
    expect(getCopilotTokenMock).toHaveBeenCalledTimes(1)
    expect(sleepMock).not.toHaveBeenCalled()
  })

  test('retries transient network errors then recovers', async () => {
    let calls = 0
    getCopilotTokenMock.mockImplementation(() => {
      calls++
      if (calls <= 2) {
        return Promise.reject(new Error('Unable to connect'))
      }
      return Promise.resolve({ token: 'recovered-token', refresh_in: 1800 })
    })

    await refreshCopilotToken(createClient())

    expect(authStore.copilotToken).toBe('recovered-token')
    expect(getCopilotTokenMock).toHaveBeenCalledTimes(3)
    expect(sleepMock).toHaveBeenCalledTimes(2)
    expect(mockConsola.warn).toHaveBeenCalledTimes(2)
  })

  test('logs error after all retries exhausted', async () => {
    getCopilotTokenMock.mockImplementation(() =>
      Promise.reject(new Error('ConnectionRefused')),
    )

    await refreshCopilotToken(createClient())

    expect(getCopilotTokenMock).toHaveBeenCalledTimes(5)
    expect(sleepMock).toHaveBeenCalledTimes(4)
    expect(mockConsola.error).toHaveBeenCalled()
  })

  test('does not retry auth HTTPError (401)', async () => {
    getCopilotTokenMock.mockImplementation(() =>
      Promise.reject(new HTTPError(401, {
        error: { message: 'Unauthorized', type: 'auth_error' },
      })),
    )

    await refreshCopilotToken(createClient())

    expect(getCopilotTokenMock).toHaveBeenCalledTimes(1)
    expect(sleepMock).not.toHaveBeenCalled()
    expect(mockConsola.error).toHaveBeenCalled()
  })

  test('retries transient HTTP errors (502, 429)', async () => {
    let calls = 0
    getCopilotTokenMock.mockImplementation(() => {
      calls++
      if (calls <= 2) {
        return Promise.reject(new HTTPError(502, {
          error: { message: 'Bad Gateway', type: 'upstream_error' },
        }))
      }
      return Promise.resolve({ token: 'recovered-after-502', refresh_in: 1800 })
    })

    await refreshCopilotToken(createClient())

    expect(authStore.copilotToken).toBe('recovered-after-502')
    expect(getCopilotTokenMock).toHaveBeenCalledTimes(3)
    expect(sleepMock).toHaveBeenCalledTimes(2)
  })
})
