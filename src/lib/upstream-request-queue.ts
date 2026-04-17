import consola from 'consola'

import { sleep as defaultSleep } from './sleep'

export interface UpstreamRequestQueueOptions {
  concurrency: number
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
}

export interface UpstreamRequestContext {
  method?: string
  url: string
}

export interface QueuedUpstreamResponse {
  response: Response
  release: () => void
}

interface UpstreamRequestQueueDeps {
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  logger?: QueueLogger
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
}

interface QueueLogger {
  warn: (message: string) => void
}

interface QueueLease {
  release: () => void
}

const DEFAULT_UPSTREAM_QUEUE_OPTIONS: UpstreamRequestQueueOptions = {
  concurrency: 10,
  maxRetries: 6,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
}

export class UpstreamRequestQueue {
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly logger: QueueLogger
  private readonly setTimer: typeof globalThis.setTimeout
  private readonly clearTimer: typeof globalThis.clearTimeout
  private options: UpstreamRequestQueueOptions
  private active = 0
  private cooldownUntil = 0
  private drainTimer: ReturnType<typeof globalThis.setTimeout> | undefined
  private readonly waiters: Array<(lease: QueueLease) => void> = []

  constructor(
    options: Partial<UpstreamRequestQueueOptions> = {},
    deps: UpstreamRequestQueueDeps = {},
  ) {
    this.options = normalizeOptions(options)
    this.sleep = deps.sleep ?? defaultSleep
    this.now = deps.now ?? Date.now
    this.logger = deps.logger ?? consola
    this.setTimer = deps.setTimeout ?? globalThis.setTimeout
    this.clearTimer = deps.clearTimeout ?? globalThis.clearTimeout
  }

  updateOptions(options: Partial<UpstreamRequestQueueOptions>): void {
    this.options = normalizeOptions(mergeDefinedOptions(this.options, options))
    this.drain()
  }

  async dispatch(
    fetcher: () => Promise<Response>,
    context: UpstreamRequestContext,
  ): Promise<QueuedUpstreamResponse> {
    let attempt = 0

    for (;;) {
      const lease = await this.acquire()
      let response: Response

      try {
        response = await fetcher()
      }
      catch (error) {
        lease.release()
        throw error
      }

      if (response.status !== 429 || attempt >= this.options.maxRetries) {
        return {
          response,
          release: lease.release,
        }
      }

      const delayMs = this.getRetryDelayMs(response, attempt)
      await discardResponse(response)
      lease.release()
      this.applyCooldown(delayMs)
      this.logger.warn(
        [
          'Upstream rate limited;',
          `retrying ${formatRequestContext(context)}`,
          `in ${formatDelay(delayMs)}`,
          `(attempt ${attempt + 1}/${this.options.maxRetries})`,
        ].join(' '),
      )
      await this.sleep(delayMs)
      attempt++
    }
  }

  private acquire(): Promise<QueueLease> {
    return new Promise((resolve) => {
      this.waiters.push(resolve)
      this.drain()
    })
  }

  private drain(): void {
    if (this.drainTimer) {
      this.clearTimer(this.drainTimer)
      this.drainTimer = undefined
    }

    const cooldownMs = this.cooldownUntil - this.now()
    if (cooldownMs > 0) {
      this.drainTimer = this.setTimer(() => this.drain(), cooldownMs)
      return
    }

    while (
      this.active < this.options.concurrency
      && this.waiters.length > 0
    ) {
      const resolve = this.waiters.shift()!
      let released = false
      this.active++
      resolve({
        release: () => {
          if (released) {
            return
          }
          released = true
          this.active--
          this.drain()
        },
      })
    }
  }

  private applyCooldown(delayMs: number): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + delayMs)
    this.drain()
  }

  private getRetryDelayMs(response: Response, attempt: number): number {
    const retryAfterMs = parseRetryAfterMs(response.headers, this.now())
    if (retryAfterMs !== undefined) {
      return clampDelay(retryAfterMs, this.options.maxDelayMs)
    }

    const exponentialDelay = this.options.baseDelayMs * 2 ** attempt
    return clampDelay(exponentialDelay, this.options.maxDelayMs)
  }
}

export function createDefaultUpstreamRequestQueue(): UpstreamRequestQueue {
  return new UpstreamRequestQueue(DEFAULT_UPSTREAM_QUEUE_OPTIONS)
}

export function parseRetryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const retryAfter = headers.get('retry-after')
  if (!retryAfter) {
    return undefined
  }

  const retryAfterSeconds = Number.parseFloat(retryAfter)
  if (Number.isFinite(retryAfterSeconds)) {
    return Math.max(0, retryAfterSeconds * 1000)
  }

  const retryAt = Date.parse(retryAfter)
  if (Number.isNaN(retryAt)) {
    return undefined
  }

  return Math.max(0, retryAt - now)
}

function normalizeOptions(
  options: Partial<UpstreamRequestQueueOptions>,
): UpstreamRequestQueueOptions {
  return {
    concurrency: Math.max(1, Math.floor(options.concurrency ?? DEFAULT_UPSTREAM_QUEUE_OPTIONS.concurrency)),
    maxRetries: Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_UPSTREAM_QUEUE_OPTIONS.maxRetries)),
    baseDelayMs: Math.max(0, Math.floor(options.baseDelayMs ?? DEFAULT_UPSTREAM_QUEUE_OPTIONS.baseDelayMs)),
    maxDelayMs: Math.max(1, Math.floor(options.maxDelayMs ?? DEFAULT_UPSTREAM_QUEUE_OPTIONS.maxDelayMs)),
  }
}

function mergeDefinedOptions(
  current: UpstreamRequestQueueOptions,
  next: Partial<UpstreamRequestQueueOptions>,
): UpstreamRequestQueueOptions {
  return {
    concurrency: next.concurrency ?? current.concurrency,
    maxRetries: next.maxRetries ?? current.maxRetries,
    baseDelayMs: next.baseDelayMs ?? current.baseDelayMs,
    maxDelayMs: next.maxDelayMs ?? current.maxDelayMs,
  }
}

function clampDelay(delayMs: number, maxDelayMs: number): number {
  return Math.min(Math.max(0, Math.ceil(delayMs)), maxDelayMs)
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  }
  catch {
    // Best effort only: retry scheduling must not fail because cleanup failed.
  }
}

function formatRequestContext(context: UpstreamRequestContext): string {
  try {
    const url = new URL(context.url)
    return `${context.method ?? 'GET'} ${url.pathname}`
  }
  catch {
    return `${context.method ?? 'GET'} ${context.url}`
  }
}

function formatDelay(delayMs: number): string {
  return delayMs < 1000
    ? `${delayMs}ms`
    : `${Math.round(delayMs / 1000)}s`
}
