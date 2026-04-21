# Retry Safety for Upstream Request Queue

**Date:** 2026-04-21
**Status:** Proposed
**Scope:** `src/lib/upstream-request-queue.ts`, `src/clients/copilot-client.ts`, tests

## Problem

The `UpstreamRequestQueue.dispatch()` retries all HTTP 429 responses unconditionally, regardless of whether the request is safe to replay. Every `CopilotClient` method flows through `fetchWithQueue()` → `dispatch()`, including mutating operations like `deleteResponse` (DELETE). While current risk is low — LLM inference endpoints are effectively idempotent and the proxy enforces `store=false` — the queue design is unsafe by default: it assumes all requests are retryable.

## Design

### Approach: Opt-in `retryable` flag (safe by default)

Add a `retryable` field to `UpstreamRequestContext`. The queue only retries 429 responses when `retryable === true`. The decision of whether an operation is retryable lives in `CopilotClient`, which has the best knowledge of operation semantics.

### Interface changes

```typescript
// upstream-request-queue.ts
export interface UpstreamRequestContext {
  method?: string
  url: string
  retryable?: boolean  // default: false — no retry on 429
}
```

```typescript
// copilot-client.ts (internal)
interface RequestOptions {
  method?: string
  body?: string
  signal?: AbortSignal
  headerOptions?: CopilotHeaderOptions
  extraHeaders?: Record<string, string>
  retryable?: boolean  // passed through to queue context
}
```

### Dispatch behavior change

Current:
```typescript
if (response.status !== 429 || attempt >= this.options.maxRetries) {
  return { response, release: lease.release }
}
// always retries
```

New:
```typescript
if (response.status !== 429 || !context.retryable || attempt >= this.options.maxRetries) {
  if (response.status === 429 && !context.retryable) {
    this.applyCooldown(this.getRetryDelayMs(response, 0))
  }
  return { response, release: lease.release }
}
// retries only when explicitly allowed
```

When `retryable === false` and a 429 is received:
- The 429 response is returned to the caller (not thrown)
- Cooldown is still applied to protect other in-flight requests
- The caller decides how to handle the 429 (existing error handling in `request()` via `throwUpstreamError`)

### Default maxRetries change

Change `DEFAULT_UPSTREAM_QUEUE_OPTIONS.maxRetries` from `6` to `5`.

### Retryable classification per CopilotClient method

| Method | HTTP | retryable | Rationale |
|--------|------|-----------|-----------|
| `createChatCompletions` | POST | `true` | LLM inference, no persistent state |
| `createMessages` | POST | `true` | LLM inference, no persistent state |
| `createResponses` | POST | `true` | LLM inference, `store=false` enforced |
| `createEmbeddings` | POST | `true` | Compute-only, deterministic |
| `createResponseInputTokens` | POST | `true` | Token counting, read-only semantics |
| `getModels` | GET | `true` | Pure read |
| `getResponse` | GET | `true` | Pure read |
| `getResponseInputItems` | GET | `true` | Pure read |
| `deleteResponse` | DELETE | `false` | Mutation — retry adds no value |

### Implementation approach

1. Add `retryable` to `UpstreamRequestContext`
2. Guard retry loop in `dispatch()` on `context.retryable`
3. Apply cooldown even when not retrying (protects queue-level state)
4. Add `retryable` to `RequestOptions` in `CopilotClient`
5. Pass `retryable` through `fetchWithQueue` → `dispatch` context
6. Mark each `CopilotClient` method with the appropriate retryable value
7. Change default `maxRetries` from 6 to 5
8. Update existing tests, add new test cases

### Test plan

- Existing queue tests: update `dispatch()` calls to pass `retryable: true` (maintaining current behavior)
- New: `retryable: false` + 429 → returns 429 response immediately, no retry
- New: `retryable: undefined` → treated as `false` (safe default)
- New: `retryable: false` + 429 → cooldown still applied
- New: `retryable: true` + 429 → retries up to maxRetries (existing behavior preserved)
- New: verify maxRetries default is 5

### Files changed

- `src/lib/upstream-request-queue.ts` — add retryable guard, change default maxRetries
- `src/clients/copilot-client.ts` — add retryable to RequestOptions, classify each method
- `tests/upstream-request-queue.test.ts` — update tests, add new cases
