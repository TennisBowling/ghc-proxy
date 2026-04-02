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

describe('GitHubClient URL routing', () => {
  describe('getDeviceCode()', () => {
    test('default config uses https://github.com', async () => {
      let capturedUrl = ''
      const mockFetch = mock((_url: string) => {
        capturedUrl = _url
        return Promise.resolve(okJson({
          device_code: 'dc',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        }))
      })

      const client = new GitHubClient(baseAuth, defaultConfig, { fetch: mockFetch as unknown as typeof fetch })
      await client.getDeviceCode()

      expect(capturedUrl).toBe('https://github.com/login/device/code')
    })

    test('GHE config routes to GHE base URL', async () => {
      let capturedUrl = ''
      const mockFetch = mock((_url: string) => {
        capturedUrl = _url
        return Promise.resolve(okJson({
          device_code: 'dc',
          user_code: 'ABCD-1234',
          verification_uri: 'https://company.ghe.com/login/device',
          expires_in: 900,
          interval: 5,
        }))
      })

      const client = new GitHubClient(baseAuth, gheConfig, { fetch: mockFetch as unknown as typeof fetch })
      await client.getDeviceCode()

      expect(capturedUrl).toBe('https://company.ghe.com/login/device/code')
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
      let capturedUrl = ''
      const mockFetch = mock((_url: string) => {
        capturedUrl = _url
        return Promise.resolve(okJson({ access_token: 'test-token', token_type: 'bearer', scope: '' }))
      })

      const client = new GitHubClient(baseAuth, defaultConfig, { fetch: mockFetch as unknown as typeof fetch })
      const token = await client.pollAccessToken(deviceCode)

      expect(capturedUrl).toBe('https://github.com/login/oauth/access_token')
      expect(token).toBe('test-token')
    })

    test('GHE config polls GHE base URL', async () => {
      let capturedUrl = ''
      const mockFetch = mock((_url: string) => {
        capturedUrl = _url
        return Promise.resolve(okJson({ access_token: 'ghe-token', token_type: 'bearer', scope: '' }))
      })

      const client = new GitHubClient(baseAuth, gheConfig, { fetch: mockFetch as unknown as typeof fetch })
      const token = await client.pollAccessToken(deviceCode)

      expect(capturedUrl).toBe('https://company.ghe.com/login/oauth/access_token')
      expect(token).toBe('ghe-token')
    })
  })

  describe('getGitHubUser()', () => {
    test('default config uses https://api.github.com', async () => {
      let capturedUrl = ''
      const mockFetch = mock((_url: string) => {
        capturedUrl = _url
        return Promise.resolve(okJson({ login: 'testuser', id: 1 }))
      })

      const client = new GitHubClient(baseAuth, defaultConfig, { fetch: mockFetch as unknown as typeof fetch })
      await client.getGitHubUser()

      expect(capturedUrl).toBe('https://api.github.com/user')
    })

    test('GHE config routes to GHE API base URL', async () => {
      let capturedUrl = ''
      const mockFetch = mock((_url: string) => {
        capturedUrl = _url
        return Promise.resolve(okJson({ login: 'gheuser', id: 2 }))
      })

      const client = new GitHubClient(baseAuth, gheConfig, { fetch: mockFetch as unknown as typeof fetch })
      await client.getGitHubUser()

      expect(capturedUrl).toBe('https://api.company.ghe.com/user')
    })
  })

  describe('getCopilotToken()', () => {
    test('default config uses https://api.github.com', async () => {
      let capturedUrl = ''
      const mockFetch = mock((_url: string) => {
        capturedUrl = _url
        return Promise.resolve(okJson({ token: 'copilot-tok', refresh_in: 1800 }))
      })

      const client = new GitHubClient(baseAuth, defaultConfig, { fetch: mockFetch as unknown as typeof fetch })
      await client.getCopilotToken()

      expect(capturedUrl).toBe('https://api.github.com/copilot_internal/v2/token')
    })

    test('GHE config routes to GHE API base URL', async () => {
      let capturedUrl = ''
      const mockFetch = mock((_url: string) => {
        capturedUrl = _url
        return Promise.resolve(okJson({ token: 'ghe-copilot-tok', refresh_in: 1800 }))
      })

      const client = new GitHubClient(baseAuth, gheConfig, { fetch: mockFetch as unknown as typeof fetch })
      await client.getCopilotToken()

      expect(capturedUrl).toBe('https://api.company.ghe.com/copilot_internal/v2/token')
    })
  })

  describe('getCopilotUsage()', () => {
    test('default config uses https://api.github.com', async () => {
      let capturedUrl = ''
      const mockFetch = mock((_url: string) => {
        capturedUrl = _url
        return Promise.resolve(okJson({ seat_breakdown: {}, total_suggestions_count: 0 }))
      })

      const client = new GitHubClient(baseAuth, defaultConfig, { fetch: mockFetch as unknown as typeof fetch })
      await client.getCopilotUsage()

      expect(capturedUrl).toBe('https://api.github.com/copilot_internal/user')
    })

    test('GHE config routes to GHE API base URL', async () => {
      let capturedUrl = ''
      const mockFetch = mock((_url: string) => {
        capturedUrl = _url
        return Promise.resolve(okJson({ seat_breakdown: {}, total_suggestions_count: 5 }))
      })

      const client = new GitHubClient(baseAuth, gheConfig, { fetch: mockFetch as unknown as typeof fetch })
      await client.getCopilotUsage()

      expect(capturedUrl).toBe('https://api.company.ghe.com/copilot_internal/user')
    })
  })
})
