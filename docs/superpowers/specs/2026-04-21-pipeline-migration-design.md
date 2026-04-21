# Pipeline Migration: Full Integration

**Date:** 2026-04-21
**Status:** Proposed
**Scope:** All route handlers, pipeline layers (transform, ingest, dispatch, guard, deliver)

## Problem

The branch created 6 pipeline abstraction layers (transform, ingest, dispatch, pipeline, guard, deliver) as part of an architecture redesign, but only `dispatch/resource-dispatcher` is wired into production. Route handlers still perform model transforms, parsing, strategy selection, and response dispatch inline. This leaves two parallel implementations — the scaffolded pipeline and the live inline code — creating maintenance burden and architectural inconsistency.

## Goal

Eliminate the dual-implementation problem by wiring all pipeline layers into production, making each route handler a thin orchestrator of the 5-stage pipeline:

```
Guard → Ingest → Transform → Dispatch → Deliver
```

## Design

### Pipeline Architecture

```
Request
  │
  ├── Guard (rate limiting)
  │
  ├── Ingest (parse + validate + extract metadata)
  │     └── ProtocolRegistry dispatches to protocol-specific parser
  │
  ├── Transform (model rewrite chain)
  │     └── Route-specific ModelTransformChain (messages: 3 steps, chat/responses: 1 step)
  │
  ├── [Route-specific logic]
  │     └── Tool transforms, emulator, CAPI plan, etc.
  │
  ├── Dispatch (strategy selection + execution + error recovery)
  │     └── StrategyRegistry + executeWithContextRetry
  │
  └── Deliver (ExecutionResult → HTTP Response)
        └── JSON serialization or SSE stream formatting + model mapping
```

### Phase 1: Transform Chain Integration

**Goal:** Replace inline model transform steps in all 3 handlers with pre-composed chains.

**Files changed:**
- `src/routes/messages/handler.ts` — replace 30-line inline pipeline (rewrite + beta + policy) with `messagesModelChain.apply()`
- `src/routes/chat-completions/handler.ts` — replace inline rewrite with `chatCompletionsModelChain.apply()`
- `src/routes/responses/handler.ts` — replace inline rewrite with `responsesModelChain.apply()`
- `src/lib/request-logger.ts` — update `ModelTransformStep` type to use trace format `{tag, from, to}`
- `src/routes/messages/handler.ts` — remove inline `processAnthropicBetaHeader()` function (moved to `transform/beta-headers.ts`)

**Trace format unification:**

Current `ModelTransformStep`:
```typescript
{ tag: string, result: string }
```

New (matching transform chain trace):
```typescript
{ tag: string, from: string, to: string }
```

This provides more debugging info (what model changed from, not just to). All consumers of `ModelMappingInfo.steps` must be updated.

**Transform chain usage example (messages handler):**
```typescript
const transformResult = messagesModelChain.apply({
  model: anthropicPayload.model,
  payload: anthropicPayload,
  headers,
})
anthropicPayload.model = transformResult.model
const selectedModel = transformResult.resolvedModel
```

### Phase 2: Dispatch Consolidation

**Goal:** Unify strategy registry, wire error recovery.

**Strategy registry:**
- Messages handler currently uses a local `StrategyEntry[]` array + `selectStrategy()` function
- Migrate to `dispatch/StrategyRegistry` class
- Move the 3 strategy entries (nativeMessages, responsesApi, chatCompletions) into a `messages/strategies/registry.ts` that creates and populates a `StrategyRegistry` instance
- Delete the duplicate `selectStrategy` function from `routes/messages/strategy-registry.ts`

**Error recovery:**
- Replace messages handler's inline context-length try/catch (lines 137-165) with `executeWithContextRetry()`
- The callback handles modelMapping update internally:

```typescript
const result = await executeWithContextRetry(
  async (model) => {
    anthropicPayload.model = model
    const retryModel = modelCache.findById(model)
    const retryEntry = registry.select(retryModel)
    return retryEntry.execute(strategyCtx)
  },
  transformResult,
)
```

**Strategy runner cleanup:**
- `dispatch/strategy-runner.ts` is a pure re-export of `~/lib/execution-strategy` — delete it
- All consumers should import directly from `~/lib/execution-strategy`

### Phase 3: Ingest Integration

**Goal:** Replace inline parse + metadata extraction with protocol registry.

**Changes per handler:**

| Handler | Current | After |
|---------|---------|-------|
| messages | `parseAnthropicMessagesPayload(body)` + `normalizeAnthropicRequestContext()` | `protocolRegistry.get('anthropic-messages').parse(body)` |
| chat-completions | `parseOpenAIChatPayload(body)` + context normalization | `protocolRegistry.get('openai-chat').parse(body)` |
| responses | `parseResponsesPayload(body)` + `normalizeResponsesRequestContext()` | `protocolRegistry.get('responses').parse(body)` |
| embeddings | `parseEmbeddingRequest(body)` | `protocolRegistry.get('embeddings').parse(body)` |
| count-tokens | `parseAnthropicCountTokensPayload(body)` | `protocolRegistry.get('anthropic-count-tokens').parse(body)` |

**Registry export:** `protocolRegistry` is created in `src/ingest/index.ts` and exported as a singleton.

### Phase 4: Deliver Layer

**Goal:** Extract response dispatch (JSON/SSE) from route.ts files into a shared deliver layer.

**Create:** `src/deliver/index.ts`

The deliver layer provides a function that converts `ExecutionResult` into the appropriate HTTP response format:

```typescript
export function deliverResult(
  result: ExecutionResult,
  modelMapping?: ModelMappingInfo,
): Response | AsyncGenerator<SSEOutput>
```

**Consolidates from 3 route files:**
- `result.kind === 'json'` → return JSON data
- `result.kind === 'stream'` → yield through `sseAdapter(result.generator)`
- Model mapping logging via `setRequestModelMapping()`

**Route-specific behavior preserved:**
- Idle timeout management stays in route.ts (it's an Elysia framework concern, not a deliver concern)
- Route.ts files become thin: parse params → call handler → call deliver

### Phase 5: Guard + Cleanup

**Guard layer:**
- Wrap existing rate limiting logic into `guard/` entry point
- Wire into route handlers (call guard before ingest)
- Guard only wraps existing rate limiting — no new auth checks

**Cleanup — delete dead code:**
- `src/pipeline/context.ts` — thin wrapper, not used
- `src/dispatch/strategy-runner.ts` — re-export, consumers import directly
- Inline `processAnthropicBetaHeader` in messages handler — moved to transform/
- Any remaining dead imports or unused functions

**Cleanup — verify no dual implementations remain:**
- Handlers should not directly import `applyModelRewrite`, `applyMessagesModelPolicy`, or parse functions
- All model transforms go through transform chains
- All parsing goes through ingest registry
- All response dispatch goes through deliver

## Migration Strategy

Each phase is an independent commit or small set of commits. Each phase must:
1. Pass all existing tests (`bun test`)
2. Pass typecheck (`bun run typecheck`)
3. Pass lint (`bun run lint:all`)
4. Not change any observable behavior

Phases can be merged independently. If a phase introduces regressions, it can be reverted without affecting other phases.

## Test Strategy

- **No new test files needed for Phases 1-3** — these are pure refactors that preserve behavior. Existing tests verify correctness.
- **Phase 4 (Deliver)** — may need tests if the deliver function has non-trivial logic
- **Phase 5 (Guard)** — needs tests if guard wraps rate limiting with new behavior
- **After all phases** — run `bun run matrix:live` to verify end-to-end compatibility (if available)

## Risk Assessment

| Phase | Risk | Mitigation |
|-------|------|-----------|
| 1. Transform | Low | Chain wraps existing functions, trace format is additive |
| 2. Dispatch | Medium | Error recovery callback must preserve exact retry semantics |
| 3. Ingest | Low | Registry delegates to same parse functions |
| 4. Deliver | Medium | Response format must be byte-identical for streaming |
| 5. Guard+Cleanup | Low | Guard wraps existing code, cleanup is deletion |
