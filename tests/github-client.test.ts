import type { ClientAuth, ClientConfig } from '../src/clients/types'

import { describe, expect, mock, test } from 'bun:test'

// Use import.meta.resolve to get the absolute file URL, bypassing Bun's mock.module registry.
// This ensures we always test the real GitHubClient even if another test file
// (e.g. token-file-removal.test.ts) has called mock.module('../src/clients/github-client').
const { GitHubClient } = await import(import.meta.resolve('../src/clients/github-client')) as typeof import('../src/clients/github-client')

// Minimal mock response factory
function okJson(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const baseAuth: ClientAuth = {
  githubToken: 'test-github-token',
  copilotToken: 'test-copilot-token',
}

const defaultConfig: ClientConfig = {
  accountType: 'individual',
}

const gheConfig: ClientConfig = {
  accountType: 'individual',
  githubBaseUrl: 'https://company.ghe.com',
  githubApiBaseUrl: 'https://api.company.ghe.com',
}

/**
 * Creates a fetch spy that:
 *  - passes a plain function typed as `typeof fetch` to GitHubClient (no mock proxy cast)
 *  - records every call URL via a Bun mock so we can assert on it
 */
function createFetchSpy(response: unknown) {
  const recorder = mock((_url: string) => _url)
  const fetchImpl = (input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
    recorder(String(input))
    return Promise.resolve(okJson(response))
  }
  return { fetchImpl: fetchImpl as unknown as typeof fetch, recorder }
}

describe('GitHubClient URL routing', () => {
  describe('getDeviceCode()', () => {
    test('default config uses https://github.com', async () => {
      const { fetchImpl, recorder } = createFetchSpy({
        device_code: 'dc',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      })

      const client = new GitHubClient(baseAuth, defaultConfig, { fetch: fetchImpl })
      await client.getDeviceCode()

      expect(recorder.mock.calls[0]?.[0]).toBe('https://github.com/login/device/code')
    })

    test('GHE config routes to GHE base URL', async () => {
      const { fetchImpl, recorder } = createFetchSpy({
        device_code: 'dc',
        user_code: 'ABCD-1234',
        verification_uri: 'https://company.ghe.com/login/device',
        expires_in: 900,
        interval: 5,
      })

      const client = new GitHubClient(baseAuth, gheConfig, { fetch: fetchImpl })
      await client.getDeviceCode()

      expect(recorder.mock.calls[0]?.[0]).toBe('https://company.ghe.com/login/device/code')
    })
  })

  describe('pollAccessToken()', () => {
    const deviceCode = {
      device_code: 'dc',
      user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 0, // 0 so test doesn't sleep long
    }

    test('default config polls https://github.com', async () => {
      const { fetchImpl, recorder } = createFetchSpy({ access_token: 'test-token', token_type: 'bearer', scope: '' })

      const client = new GitHubClient(baseAuth, defaultConfig, { fetch: fetchImpl })
      const token = await client.pollAccessToken(deviceCode)

      expect(recorder.mock.calls[0]?.[0]).toBe('https://github.com/login/oauth/access_token')
      expect(token).toBe('test-token')
    })

    test('GHE config polls GHE base URL', async () => {
      const { fetchImpl, recorder } = createFetchSpy({ access_token: 'ghe-token', token_type: 'bearer', scope: '' })

      const client = new GitHubClient(baseAuth, gheConfig, { fetch: fetchImpl })
      const token = await client.pollAccessToken(deviceCode)

      expect(recorder.mock.calls[0]?.[0]).toBe('https://company.ghe.com/login/oauth/access_token')
      expect(token).toBe('ghe-token')
    })
  })

  describe('getGitHubUser()', () => {
    test('default config uses https://api.github.com', async () => {
      const { fetchImpl, recorder } = createFetchSpy({ login: 'testuser', id: 1 })

      const client = new GitHubClient(baseAuth, defaultConfig, { fetch: fetchImpl })
      await client.getGitHubUser()

      expect(recorder.mock.calls[0]?.[0]).toBe('https://api.github.com/user')
    })

    test('GHE config routes to GHE API base URL', async () => {
      const { fetchImpl, recorder } = createFetchSpy({ login: 'gheuser', id: 2 })

      const client = new GitHubClient(baseAuth, gheConfig, { fetch: fetchImpl })
      await client.getGitHubUser()

      expect(recorder.mock.calls[0]?.[0]).toBe('https://api.company.ghe.com/user')
    })
  })

  describe('getCopilotToken()', () => {
    test('default config uses https://api.github.com', async () => {
      const { fetchImpl, recorder } = createFetchSpy({ token: 'copilot-tok', refresh_in: 1800 })

      const client = new GitHubClient(baseAuth, defaultConfig, { fetch: fetchImpl })
      await client.getCopilotToken()

      expect(recorder.mock.calls[0]?.[0]).toBe('https://api.github.com/copilot_internal/v2/token')
    })

    test('GHE config routes to GHE API base URL', async () => {
      const { fetchImpl, recorder } = createFetchSpy({ token: 'ghe-copilot-tok', refresh_in: 1800 })

      const client = new GitHubClient(baseAuth, gheConfig, { fetch: fetchImpl })
      await client.getCopilotToken()

      expect(recorder.mock.calls[0]?.[0]).toBe('https://api.company.ghe.com/copilot_internal/v2/token')
    })
  })

  describe('getCopilotUsage()', () => {
    test('default config uses https://api.github.com', async () => {
      const { fetchImpl, recorder } = createFetchSpy({ seat_breakdown: {}, total_suggestions_count: 0 })

      const client = new GitHubClient(baseAuth, defaultConfig, { fetch: fetchImpl })
      await client.getCopilotUsage()

      expect(recorder.mock.calls[0]?.[0]).toBe('https://api.github.com/copilot_internal/user')
    })

    test('GHE config routes to GHE API base URL', async () => {
      const { fetchImpl, recorder } = createFetchSpy({ seat_breakdown: {}, total_suggestions_count: 5 })

      const client = new GitHubClient(baseAuth, gheConfig, { fetch: fetchImpl })
      await client.getCopilotUsage()

      expect(recorder.mock.calls[0]?.[0]).toBe('https://api.company.ghe.com/copilot_internal/user')
    })
  })
})
