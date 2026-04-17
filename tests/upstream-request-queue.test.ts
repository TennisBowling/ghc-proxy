import { describe, expect, test } from 'bun:test'

import { createDefaultUpstreamRequestQueue, parseRetryAfterMs, UpstreamRequestQueue } from '~/lib/upstream-request-queue'

describe('parseRetryAfterMs', () => {
  test('parses delta seconds', () => {
    const headers = new Headers({ 'retry-after': '2.5' })

    expect(parseRetryAfterMs(headers, 1_000)).toBe(2_500)
  })

  test('parses HTTP dates', () => {
    const headers = new Headers({
      'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT',
    })

    expect(parseRetryAfterMs(headers, Date.parse('Wed, 21 Oct 2015 07:27:55 GMT'))).toBe(5_000)
  })
})

describe('UpstreamRequestQueue', () => {
  test('default queue allows 10 concurrent upstream responses', async () => {
    const queue = createDefaultUpstreamRequestQueue()
    const responses = []
    let calls = 0

    for (let i = 0; i < 10; i++) {
      responses.push(await queue.dispatch(
        () => {
          calls++
          return Promise.resolve(new Response('ok'))
        },
        { method: 'POST', url: 'https://api.githubcopilot.com/v1/messages' },
      ))
    }

    const blocked = queue.dispatch(
      () => {
        calls++
        return Promise.resolve(new Response('ok'))
      },
      { method: 'POST', url: 'https://api.githubcopilot.com/v1/messages' },
    )

    await Promise.resolve()
    expect(calls).toBe(10)

    responses[0]!.release()
    const eleventh = await blocked
    expect(calls).toBe(11)

    eleventh.release()
    for (const response of responses.slice(1)) {
      response.release()
    }
  })

  test('retries upstream 429 using Retry-After before returning a successful response', async () => {
    let now = 1_000
    const sleeps: number[] = []
    const queue = new UpstreamRequestQueue(
      {
        concurrency: 1,
        maxRetries: 2,
        baseDelayMs: 10,
        maxDelayMs: 5_000,
      },
      {
        now: () => now,
        sleep: (ms) => {
          sleeps.push(ms)
          now += ms
          return Promise.resolve()
        },
        logger: {
          warn: () => {},
        },
        setTimeout: ((_callback: () => void) => {
          return undefined as unknown as ReturnType<typeof setTimeout>
        }) as typeof setTimeout,
        clearTimeout: (() => {}) as typeof clearTimeout,
      },
    )

    let calls = 0
    const queued = await queue.dispatch(
      () => {
        calls++
        return Promise.resolve(
          calls === 1
            ? new Response('too many requests\n', {
                status: 429,
                headers: { 'retry-after': '3' },
              })
            : new Response(JSON.stringify({ ok: true }), {
                headers: { 'content-type': 'application/json' },
              }),
        )
      },
      { method: 'POST', url: 'https://api.githubcopilot.com/v1/messages' },
    )

    expect(calls).toBe(2)
    expect(sleeps).toEqual([3_000])
    expect(await queued.response.json()).toEqual({ ok: true })
    queued.release()
  })

  test('serializes requests until the active response releases its queue slot', async () => {
    const queue = new UpstreamRequestQueue(
      {
        concurrency: 1,
        maxRetries: 0,
        baseDelayMs: 1,
        maxDelayMs: 1,
      },
      {
        sleep: () => Promise.resolve(),
        logger: {
          warn: () => {},
        },
      },
    )

    const order: string[] = []
    const first = await queue.dispatch(
      () => {
        order.push('first')
        return Promise.resolve(new Response('first'))
      },
      { method: 'POST', url: 'https://api.githubcopilot.com/v1/messages' },
    )

    const secondPromise = queue.dispatch(
      () => {
        order.push('second')
        return Promise.resolve(new Response('second'))
      },
      { method: 'POST', url: 'https://api.githubcopilot.com/v1/messages' },
    )

    await Promise.resolve()
    expect(order).toEqual(['first'])

    first.release()
    const second = await secondPromise
    expect(order).toEqual(['first', 'second'])
    second.release()
  })

  test('can update concurrency without replacing retry settings', async () => {
    const queue = new UpstreamRequestQueue(
      {
        concurrency: 1,
        maxRetries: 0,
        baseDelayMs: 1,
        maxDelayMs: 1,
      },
      {
        sleep: () => Promise.resolve(),
        logger: {
          warn: () => {},
        },
      },
    )

    queue.updateOptions({ concurrency: 2 })

    const order: string[] = []
    const first = await queue.dispatch(
      () => {
        order.push('first')
        return Promise.resolve(new Response('first'))
      },
      { method: 'POST', url: 'https://api.githubcopilot.com/v1/messages' },
    )
    const second = await queue.dispatch(
      () => {
        order.push('second')
        return Promise.resolve(new Response('second'))
      },
      { method: 'POST', url: 'https://api.githubcopilot.com/v1/messages' },
    )

    expect(order).toEqual(['first', 'second'])
    first.release()
    second.release()
  })
})
