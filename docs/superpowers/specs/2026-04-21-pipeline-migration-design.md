# Pipeline Migration: Full Integration

**Date:** 2026-04-21
**Status:** In Progress (Phases 1/3/4 complete, Phases 2/5 remaining)
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

### Phase 1: Transform Chain Integration — ✅ COMPLETE

All 3 handlers use pre-composed model transform chains:
- `messagesModelChain.apply()` (3 steps: rewrite → beta → policy)
- `chatCompletionsModelChain.apply()` (1 step: rewrite)
- `responsesModelChain.apply()` (1 step: rewrite)

Trace format unified to `{ tag, from, to }`.

### Phase 2: Dispatch Consolidation — ❌ REMAINING

**Goal:** Unify all routes to use `StrategyRegistry` from `src/dispatch/`.

#### 2a. Unified StrategyEntry interface

Two incompatible interfaces exist:
- Generic `src/dispatch/strategy-registry.ts`: `createStrategy(...args) => ExecutionStrategy`
- Local `src/routes/messages/strategy-registry.ts`: `execute(ctx) => Promise<StrategyResult>`

Unify to generic `execute()` pattern on `StrategyRegistry<TContext>`:

```typescript
// src/dispatch/strategy-registry.ts
export interface StrategyEntry<TContext = unknown> {
  name: string
  canHandle: (model: Model | undefined) => boolean
  execute: (ctx: TContext) => Promise<ExecutionResult>
}

export class StrategyRegistry<TContext = unknown> {
  private entries: StrategyEntry<TContext>[] = []

  register(entry: StrategyEntry<TContext>): void {
    this.entries.push(entry)
  }

  select(model: Model | undefined): StrategyEntry<TContext> {
    for (const entry of this.entries) {
      if (entry.canHandle(model)) {
        consola.debug(`Strategy selected: ${entry.name} for model: ${model?.id ?? '(unknown)'}`)
        return entry
      }
    }
    return this.entries.at(-1)!
  }
}
```

#### 2b. Messages: migrate to generic StrategyRegistry

- `src/routes/messages/strategy-registry.ts`:
  - Delete local `StrategyEntry` interface and `selectStrategy()` function
  - Convert `defaultStrategyRegistry` from `Array<StrategyEntry>` to `StrategyRegistry<MessagesStrategyContext>` instance
  - 3 strategy entries + helper functions (filterThinkingBlocks, sanitizeOutputConfig, etc.) remain in this file
  - Update `execute()` to return `ExecutionResult` directly (modelMapping handling stays in handler)
- `src/routes/messages/handler.ts`:
  - Use `defaultStrategyRegistry.select(model)` instead of `selectStrategy(defaultStrategyRegistry, model)`

#### 2c. Chat-completions: add StrategyRegistry

- New file `src/routes/chat-completions/strategy-registry.ts`:
  - Create `chatCompletionsStrategyRegistry` with single entry
  - Entry's `execute()` encapsulates: adapter setup → CAPI plan → transport → strategy creation → runStrategy
- `src/routes/chat-completions/handler.ts`:
  - Use `registry.select()` + `entry.execute()` instead of inline strategy creation

#### 2d. Responses: add StrategyRegistry

- New file `src/routes/responses/strategy-registry.ts`:
  - Create `responsesStrategyRegistry` with single entry
  - Entry's `execute()` encapsulates: tool transforms → input policies → context management → strategy creation → runStrategy → emulator post-processing
- `src/routes/responses/handler.ts`:
  - Use `registry.select()` + `entry.execute()` instead of inline strategy creation

### Phase 3: Ingest Integration — ⚠️ 1 BYPASS REMAINING

5 of 6 handlers properly use `protocolRegistry.ingest()`. One bypass remains:

**Fix:** `src/routes/responses/resource-handler.ts` `handleCreateResponseInputTokensCore()`:
- Replace `parseResponsesInputTokensPayload(body)` + `normalizeResponsesRequestContext(payload, headers)` with `protocolRegistry.ingest('responses-input-tokens', body, headers)`
- `meta.requestContext` replaces manual normalization (ingest handler calls the same function internally)

### Phase 4: Deliver Layer — ✅ COMPLETE

`deliverResult()` in `src/deliver/index.ts` handles all streaming routes. Non-streaming routes return plain objects directly.

### Phase 5: Guard + Cleanup — ❌ REMAINING

#### 5a. Guard: `/embeddings` route

`src/routes/embeddings/route.ts`:
- Import and `.use(requestGuardPlugin)`
- Add `{ guarded: true }` to POST handler

#### 5b. Guard: `/responses` resource routes

`src/routes/responses/route.ts`:
- Add `{ guarded: true }` to:
  - `GET /responses/:responseId/input_items`
  - `GET /responses/:responseId`
  - `DELETE /responses/:responseId`
- Plugin is already registered (`.use(requestGuardPlugin)` at top), only the option is missing

#### 5c. Routes intentionally without guard

- `/models` — read-only public info (per original design doc)
- `/token`, `/usage` — read-only diagnostic endpoints

#### 5d. Documentation update

- This spec: Status → "Implemented"
- `CLAUDE.md` + `AGENTS.md`: Update architecture section to describe 5-layer pipeline instead of "4-stage model transformation", update Key Modules table

#### 5e. Cleanup

- Verify no dual implementations remain
- Delete dead dispatch code if any (`dispatch/strategy-runner.ts` if still exists)

## Migration Strategy

Each phase is an independent commit or small set of commits. Each phase must:
1. Pass all existing tests (`bun test`)
2. Pass typecheck (`bun run typecheck`)
3. Pass lint (`bun run lint:all`)
4. Not change any observable behavior

Phases can be merged independently. If a phase introduces regressions, it can be reverted without affecting other phases.

## Test Strategy

- **No new test files needed** — these are pure refactors that preserve behavior. Existing tests verify correctness.
- **After all phases** — run `bun run matrix:live` to verify end-to-end compatibility (if available)

## Risk Assessment

| Phase | Risk | Mitigation |
|-------|------|-----------|
| 1. Transform | ✅ Complete | — |
| 2. Dispatch | Medium | Preserve exact entry execution semantics; messages retry logic must re-select strategy |
| 3. Ingest | ✅ Complete (1 fix remaining) | Registry delegates to same parse function |
| 4. Deliver | ✅ Complete | — |
| 5. Guard+Cleanup | Low | Guard wraps existing code, cleanup is deletion |
