import { describe, expect, mock, test } from 'bun:test'

import {
  disableIdleTimeout,
  hasStreamingFlag,
  hasStreamingResponsesQuery,
} from '~/lib/request-timeout'

describe('request-timeout helpers', () => {
  test('disableIdleTimeout delegates to Bun server timeout with 0 seconds', () => {
    const timeout = mock()

    const request = new Request('http://localhost/v1/messages')
    disableIdleTimeout({ timeout }, request)

    expect(timeout).toHaveBeenCalledTimes(1)
    expect(timeout).toHaveBeenCalledWith(request, 0)
  })

  test('disableIdleTimeout is a no-op when timeout is unavailable', () => {
    const request = new Request('http://localhost/v1/messages')

    expect(() => disableIdleTimeout(null, request)).not.toThrow()
    expect(() => disableIdleTimeout({}, request)).not.toThrow()
  })

  test('hasStreamingFlag only enables true boolean stream values', () => {
    expect(hasStreamingFlag({ stream: true })).toBe(true)
    expect(hasStreamingFlag({ stream: false })).toBe(false)
    expect(hasStreamingFlag({ stream: 'true' })).toBe(false)
    expect(hasStreamingFlag(undefined)).toBe(false)
  })

  test('hasStreamingResponsesQuery checks the retrieve stream query flag', () => {
    expect(hasStreamingResponsesQuery({
      url: 'http://localhost/v1/responses/resp_123?stream=true',
    })).toBe(true)

    expect(hasStreamingResponsesQuery({
      url: 'http://localhost/v1/responses/resp_123?stream=false',
    })).toBe(false)
  })
})
