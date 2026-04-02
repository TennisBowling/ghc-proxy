import type { ClientAuth, ClientConfig } from '../src/clients/types'

import { describe, expect, mock, test } from 'bun:test'
import { GitHubClient } from '../src/clients/github-client'

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

function createMockFetch(response: unknown) {
  return mock(() => Promise.resolve(okJson(response))) as unknown as typeof fetch
}

function capturedUrl(mockFn: typeof fetch): string {
  const calls = (mockFn as unknown as ReturnType<typeof mock>).mock.calls
  return String(calls[0]?.[0] ?? '')
}

describe('GitHubClient URL routing', () => {
  describe('getDeviceCode()', () => {
    test('default config uses https://github.com', async () => {
      const mockFetch = createMockFetch({
        device_code: 'dc',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      })

      const client = new GitHubClient(baseAuth, defaultConfig, { fetch: mockFetch })
      await client.getDeviceCode()

      expect(capturedUrl(mockFetch)).toBe('https://github.com/login/device/code')
    })

    test('GHE config routes to GHE base URL', async () => {
      const mockFetch = createMockFetch({
        device_code: 'dc',
        user_code: 'ABCD-1234',
        verification_uri: 'https://company.ghe.com/login/device',
        expires_in: 900,
        interval: 5,
      })

      const client = new GitHubClient(baseAuth, gheConfig, { fetch: mockFetch })
      await client.getDeviceCode()

      expect(capturedUrl(mockFetch)).toBe('https://company.ghe.com/login/device/code')
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
      const mockFetch = createMockFetch({ access_token: 'test-token', token_type: 'bearer', scope: '' })

      const client = new GitHubClient(baseAuth, defaultConfig, { fetch: mockFetch })
      const token = await client.pollAccessToken(deviceCode)

      expect(capturedUrl(mockFetch)).toBe('https://github.com/login/oauth/access_token')
      expect(token).toBe('test-token')
    })

    test('GHE config polls GHE base URL', async () => {
      const mockFetch = createMockFetch({ access_token: 'ghe-token', token_type: 'bearer', scope: '' })

      const client = new GitHubClient(baseAuth, gheConfig, { fetch: mockFetch })
      const token = await client.pollAccessToken(deviceCode)

      expect(capturedUrl(mockFetch)).toBe('https://company.ghe.com/login/oauth/access_token')
      expect(token).toBe('ghe-token')
    })
  })

  describe('getGitHubUser()', () => {
    test('default config uses https://api.github.com', async () => {
      const mockFetch = createMockFetch({ login: 'testuser', id: 1 })

      const client = new GitHubClient(baseAuth, defaultConfig, { fetch: mockFetch })
      await client.getGitHubUser()

      expect(capturedUrl(mockFetch)).toBe('https://api.github.com/user')
    })

    test('GHE config routes to GHE API base URL', async () => {
      const mockFetch = createMockFetch({ login: 'gheuser', id: 2 })

      const client = new GitHubClient(baseAuth, gheConfig, { fetch: mockFetch })
      await client.getGitHubUser()

      expect(capturedUrl(mockFetch)).toBe('https://api.company.ghe.com/user')
    })
  })

  describe('getCopilotToken()', () => {
    test('default config uses https://api.github.com', async () => {
      const mockFetch = createMockFetch({ token: 'copilot-tok', refresh_in: 1800 })

      const client = new GitHubClient(baseAuth, defaultConfig, { fetch: mockFetch })
      await client.getCopilotToken()

      expect(capturedUrl(mockFetch)).toBe('https://api.github.com/copilot_internal/v2/token')
    })

    test('GHE config routes to GHE API base URL', async () => {
      const mockFetch = createMockFetch({ token: 'ghe-copilot-tok', refresh_in: 1800 })

      const client = new GitHubClient(baseAuth, gheConfig, { fetch: mockFetch })
      await client.getCopilotToken()

      expect(capturedUrl(mockFetch)).toBe('https://api.company.ghe.com/copilot_internal/v2/token')
    })
  })

  describe('getCopilotUsage()', () => {
    test('default config uses https://api.github.com', async () => {
      const mockFetch = createMockFetch({ seat_breakdown: {}, total_suggestions_count: 0 })

      const client = new GitHubClient(baseAuth, defaultConfig, { fetch: mockFetch })
      await client.getCopilotUsage()

      expect(capturedUrl(mockFetch)).toBe('https://api.github.com/copilot_internal/user')
    })

    test('GHE config routes to GHE API base URL', async () => {
      const mockFetch = createMockFetch({ seat_breakdown: {}, total_suggestions_count: 5 })

      const client = new GitHubClient(baseAuth, gheConfig, { fetch: mockFetch })
      await client.getCopilotUsage()

      expect(capturedUrl(mockFetch)).toBe('https://api.company.ghe.com/copilot_internal/user')
    })
  })
})
