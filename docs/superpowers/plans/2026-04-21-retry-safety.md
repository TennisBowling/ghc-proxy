# Retry Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the upstream request queue safe by default — only retry 429 responses when the caller explicitly opts in via a `retryable` flag.

**Architecture:** Add `retryable?: boolean` to `UpstreamRequestContext` (default `false`). Guard the retry loop in `dispatch()`. Propagate the flag through `CopilotClient.request()` → `fetchWithQueue()` → `dispatch()`. Each `CopilotClient` method declares its own retry safety.

**Tech Stack:** TypeScript, Bun test runner

**Spec:** `docs/superpowers/specs/2026-04-21-retry-safety-design.md`

---

### Task 1: Add `retryable` field and change default maxRetries

**Files:**
- Modify: `src/lib/upstream-request-queue.ts:12-15` (UpstreamRequestContext interface)
- Modify: `src/lib/upstream-request-queue.ts:38-43` (DEFAULT_UPSTREAM_QUEUE_OPTIONS)

- [ ] **Step 1: Add `retryable` to `UpstreamRequestContext`**

In `src/lib/upstream-request-queue.ts`, update the interface:

```typescript
export interface UpstreamRequestContext {
  method?: string
  url: string
  retryable?: boolean
}
```

- [ ] **Step 2: Change default maxRetries from 6 to 5**

In `src/lib/upstream-request-queue.ts`, update the constant:

```typescript
const DEFAULT_UPSTREAM_QUEUE_OPTIONS: UpstreamRequestQueueOptions = {
  concurrency: 10,
  maxRetries: 5,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
}
```

- [ ] **Step 3: Verify typecheck passes**

Run: `bun run typecheck`
Expected: PASS (retryable is optional, no consumers break)

- [ ] **Step 4: Verify tests still pass**

Run: `bun test tests/upstream-request-queue.test.ts`
Expected: PASS (no behavioral change yet)

- [ ] **Step 5: Commit**

```bash
git add src/lib/upstream-request-queue.ts
git commit -m "refactor: add retryable field to UpstreamRequestContext, reduce default maxRetries to 5"
```

---

### Task 2: Write failing tests for non-retryable 429 behavior

**Files:**
- Modify: `tests/upstream-request-queue.test.ts`

- [ ] **Step 1: Write test — retryable false returns 429 without retrying**

Append inside the `describe('UpstreamRequestQueue', ...)` block in `tests/upstream-request-queue.test.ts`:

```typescript
test('does not retry 429 when retryable is false', async () => {
  const queue = new UpstreamRequestQueue(
    {
      concurrency: 1,
      maxRetries: 5,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
    },
    {
      sleep: () => Promise.resolve(),
      logger: { warn: () => {} },
    },
  )

  let calls = 0
  const queued = await queue.dispatch(
    () => {
      calls++
      return Promise.resolve(new Response('rate limited', { status: 429 }))
    },
    { method: 'POST', url: 'https://api.githubcopilot.com/responses', retryable: false },
  )

  expect(calls).toBe(1)
  expect(queued.response.status).toBe(429)
  queued.release()
})
```

- [ ] **Step 2: Write test — retryable undefined (omitted) defaults to no retry**

```typescript
test('does not retry 429 when retryable is omitted (safe default)', async () => {
  const queue = new UpstreamRequestQueue(
    {
      concurrency: 1,
      maxRetries: 5,
      baseDelayMs: 10,
      maxDelayMs: 5_000,
    },
    {
      sleep: () => Promise.resolve(),
      logger: { warn: () => {} },
    },
  )

  let calls = 0
  const queued = await queue.dispatch(
    () => {
      calls++
      return Promise.resolve(new Response('rate limited', { status: 429 }))
    },
    { method: 'DELETE', url: 'https://api.githubcopilot.com/responses/resp_123' },
  )

  expect(calls).toBe(1)
  expect(queued.response.status).toBe(429)
  queued.release()
})
```

- [ ] **Step 3: Write test — non-retryable 429 still applies cooldown**

```typescript
test('applies cooldown even when retryable is false', async () => {
  let now = 1_000
  const timers: Array<{ callback: () => void, delay: number }> = []
  const queue = new UpstreamRequestQueue(
    {
      concurrency: 1,
      maxRetries: 5,
      baseDelayMs: 2_000,
      maxDelayMs: 60_000,
    },
    {
      now: () => now,
      sleep: () => Promise.resolve(),
      logger: { warn: () => {} },
      setTimeout: ((callback: () => void, delay: number) => {
        timers.push({ callback, delay })
        return timers.length as unknown as ReturnType<typeof setTimeout>
      }) as typeof setTimeout,
      clearTimeout: (() => {}) as typeof clearTimeout,
    },
  )

  const queued = await queue.dispatch(
    () => Promise.resolve(
      new Response('rate limited', {
        status: 429,
        headers: { 'retry-after': '10' },
      }),
    ),
    { method: 'DELETE', url: 'https://api.githubcopilot.com/responses/resp_123', retryable: false },
  )

  expect(queued.response.status).toBe(429)
  queued.release()

  // Cooldown should have been applied — the drain timer should be set
  // with a delay derived from the retry-after header
  expect(timers.length).toBeGreaterThanOrEqual(1)
  const lastTimer = timers.at(-1)!
  expect(lastTimer.delay).toBeGreaterThan(0)
})
```

- [ ] **Step 4: Write test — retryable true still retries (regression guard)**

```typescript
test('retries 429 when retryable is true', async () => {
  const queue = new UpstreamRequestQueue(
    {
      concurrency: 1,
      maxRetries: 5,
      baseDelayMs: 10,
      maxDelayMs: 5_000,
    },
    {
      sleep: () => Promise.resolve(),
      logger: { warn: () => {} },
    },
  )

  let calls = 0
  const queued = await queue.dispatch(
    () => {
      calls++
      return Promise.resolve(
        calls === 1
          ? new Response('rate limited', { status: 429 })
          : new Response(JSON.stringify({ ok: true })),
      )
    },
    { method: 'POST', url: 'https://api.githubcopilot.com/v1/messages', retryable: true },
  )

  expect(calls).toBe(2)
  expect(await queued.response.json()).toEqual({ ok: true })
  queued.release()
})
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `bun test tests/upstream-request-queue.test.ts`
Expected: The first two new tests FAIL (dispatch still retries regardless of retryable). The cooldown test may pass or fail depending on timing. The retryable-true test should pass (current behavior).

- [ ] **Step 6: Commit failing tests**

```bash
git add tests/upstream-request-queue.test.ts
git commit -m "test: add failing tests for retryable 429 behavior"
```

---

### Task 3: Implement dispatch guard for retryable

**Files:**
- Modify: `src/lib/upstream-request-queue.ts:74-116` (dispatch method)

- [ ] **Step 1: Guard retry loop on `context.retryable`**

In `src/lib/upstream-request-queue.ts`, replace lines 94-114 of the `dispatch` method (the block after `response = await fetcher()`) with:

```typescript
      if (response.status !== 429 || !context.retryable || attempt >= this.options.maxRetries) {
        if (response.status === 429 && !context.retryable) {
          this.applyCooldown(this.getRetryDelayMs(response, 0))
        }
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
      await abortableSleep(this.sleep, delayMs, signal)
      attempt++
```

- [ ] **Step 2: Run new tests to verify they pass**

Run: `bun test tests/upstream-request-queue.test.ts`
Expected: All four new tests PASS. Some existing tests may FAIL (next task fixes those).

- [ ] **Step 3: Commit**

```bash
git add src/lib/upstream-request-queue.ts
git commit -m "fix: guard 429 retry on retryable flag in upstream queue"
```

---

### Task 4: Fix existing tests that exercise retry

**Files:**
- Modify: `tests/upstream-request-queue.test.ts`

Two existing tests dispatch with a 429 fetcher and expect retry behavior. They need `retryable: true` in their context.

- [ ] **Step 1: Fix "retries upstream 429 using Retry-After" test**

In `tests/upstream-request-queue.test.ts`, find the test `'retries upstream 429 using Retry-After before returning a successful response'` and update the dispatch context (around line 100):

Change:
```typescript
      { method: 'POST', url: 'https://api.githubcopilot.com/v1/messages' },
```
To:
```typescript
      { method: 'POST', url: 'https://api.githubcopilot.com/v1/messages', retryable: true },
```

- [ ] **Step 2: Fix "aborts backoff sleep when signal fires during retry wait" test**

Find the test `'aborts backoff sleep when signal fires during retry wait'` and update its dispatch context (around line 280):

Change:
```typescript
      { url: 'https://test' },
```
To:
```typescript
      { url: 'https://test', retryable: true },
```

- [ ] **Step 3: Run all queue tests to verify everything passes**

Run: `bun test tests/upstream-request-queue.test.ts`
Expected: ALL tests PASS

- [ ] **Step 4: Commit**

```bash
git add tests/upstream-request-queue.test.ts
git commit -m "test: add retryable: true to existing retry tests"
```

---

### Task 5: Wire retryable through CopilotClient

**Files:**
- Modify: `src/clients/copilot-client.ts:30-36` (RequestOptions interface)
- Modify: `src/clients/copilot-client.ts:63-98` (request method)
- Modify: `src/clients/copilot-client.ts:140-155` (fetchWithQueue method)
- Modify: `src/clients/copilot-client.ts:157-329` (all endpoint methods)

- [ ] **Step 1: Add `retryable` to `RequestOptions`**

In `src/clients/copilot-client.ts`, update the `RequestOptions` interface:

```typescript
interface RequestOptions {
  method?: string
  body?: string
  signal?: AbortSignal
  headerOptions?: CopilotHeaderOptions
  extraHeaders?: Record<string, string>
  retryable?: boolean
}
```

- [ ] **Step 2: Pass `retryable` through `fetchWithQueue`**

Update `fetchWithQueue` to include `retryable` in the context passed to `dispatch`:

```typescript
  private async fetchWithQueue(
    request: FetchParams,
    retryable?: boolean,
  ): Promise<QueuedUpstreamResponse> {
    const fetcher = () => this.fetchImpl(request.url, request.init)
    if (this.requestQueue) {
      return this.requestQueue.dispatch(fetcher, {
        method: request.init.method,
        url: request.url,
        retryable,
      }, request.init.signal ?? undefined)
    }

    return {
      response: await fetcher(),
      release: () => {},
    }
  }
```

- [ ] **Step 3: Pass `retryable` from `request` to `fetchWithQueue`**

Update the `request` method to forward the retryable option:

```typescript
    const queuedResponse = await this.fetchWithQueue(request, options.retryable)
```

- [ ] **Step 4: Mark LLM inference methods as retryable**

Update `requestStreamable` to default `retryable: true` since it's only used for LLM inference:

```typescript
  private async requestStreamable<T>(
    path: string,
    payload: { stream?: boolean | null },
    errorMessage: string,
    options?: Omit<RequestOptions, 'method' | 'body'>,
  ) {
    const { response, release } = await this.request(path, errorMessage, {
      method: 'POST',
      body: JSON.stringify(payload),
      retryable: true,
      ...options,
    })
```

This covers `createChatCompletions`, `createMessages`, and `createResponses` — all of which go through `requestStreamable`.

- [ ] **Step 5: Mark read and compute methods as retryable**

Update `getModels` (line ~201):
```typescript
  async getModels(): Promise<ModelsResponse> {
    return this.requestJson<ModelsResponse>(
      '/models',
      'Failed to get models',
      { retryable: true },
    )
  }
```

Update `getResponse` (line ~232):
```typescript
  async getResponse(
    responseId: string,
    options?: {
      signal?: AbortSignal
      params?: ResponseRetrieveParams
      requestContext?: Partial<CapiRequestContext>
    },
  ): Promise<ResponsesResult | Record<string, unknown>> {
    return this.requestJson<ResponsesResult | Record<string, unknown>>(
      this.buildResponsesUrl(responseId, options?.params),
      'Failed to get response',
      {
        signal: options?.signal,
        headerOptions: { requestContext: options?.requestContext },
        retryable: true,
      },
    )
  }
```

Update `getResponseInputItems` (line ~250):
```typescript
  async getResponseInputItems(
    responseId: string,
    params?: ResponseInputItemsListParams,
    options?: {
      signal?: AbortSignal
      requestContext?: Partial<CapiRequestContext>
    },
  ): Promise<ResponseInputItemsListResult | Record<string, unknown>> {
    return this.requestJson<ResponseInputItemsListResult | Record<string, unknown>>(
      this.buildResponseInputItemsUrl(responseId, params),
      'Failed to get response input items',
      {
        signal: options?.signal,
        headerOptions: { requestContext: options?.requestContext },
        retryable: true,
      },
    )
  }
```

Update `createEmbeddings` (line ~191):
```typescript
  async createEmbeddings(
    payload: EmbeddingRequest,
  ): Promise<EmbeddingResponse> {
    return this.requestJson<EmbeddingResponse>(
      '/embeddings',
      'Failed to create embeddings',
      { method: 'POST', body: JSON.stringify(payload), retryable: true },
    )
  }
```

Update `createResponseInputTokens` (line ~268):
```typescript
  async createResponseInputTokens(
    payload: ResponsesInputTokensPayload,
    options?: {
      signal?: AbortSignal
      requestContext?: Partial<CapiRequestContext>
    },
  ): Promise<ResponseInputTokensResult | Record<string, unknown>> {
    return this.requestJson<ResponseInputTokensResult | Record<string, unknown>>(
      '/responses/input_tokens',
      'Failed to create response input tokens',
      {
        method: 'POST',
        body: JSON.stringify(payload),
        signal: options?.signal,
        headerOptions: { requestContext: options?.requestContext },
        retryable: true,
      },
    )
  }
```

- [ ] **Step 6: Verify `deleteResponse` remains non-retryable (no change needed)**

`deleteResponse` passes no `retryable` option → defaults to `undefined` → treated as `false` by the queue. No code change needed, just verify by reading the method.

- [ ] **Step 7: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 8: Run all tests**

Run: `bun test`
Expected: ALL tests PASS

- [ ] **Step 9: Commit**

```bash
git add src/clients/copilot-client.ts
git commit -m "fix: classify CopilotClient methods by retry safety"
```

---

### Task 6: Final validation

- [ ] **Step 1: Run full CI pipeline locally**

Run: `bun run lint:all && bun run typecheck && bun run build && bun test`
Expected: ALL steps PASS

- [ ] **Step 2: Review the complete diff**

Run: `git diff main...HEAD --stat` and `git log --oneline main...HEAD`
Verify: Changes are limited to the three files in scope.

- [ ] **Step 3: Squash commits if desired**

The five commits from Tasks 1-5 can remain separate or be squashed for a cleaner history. This is a preference decision.
