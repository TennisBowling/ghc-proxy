# Architecture Redesign: Typed Context Pipeline

**Date:** 2026-04-17
**Status:** Design
**Scope:** Full internal refactoring — all layers (pipeline, translation, state, routes)
**Constraints:** External contracts preserved (API endpoints, CLI arguments, config.json schema)

## Overview

Restructure ghc-proxy's internals around a **pipeline-stage-based architecture** with:

- **Composable model transform chain** replacing inline if-else in handlers
- **Protocol registry** for declarative protocol parsing
- **Translator registry** with direct protocol-pair translators organized by trait
- **Decomposed state stores** replacing the global AppState god object
- **Pipeline-stage-based directory structure** mirroring the request data flow

The goal is to make the codebase lean, modular, and extensible without introducing new features.

## 1. Pipeline Framework

### Core Insight

Different routes need different pipeline stages. The pipeline is not a single fixed chain but a **composable stage library** — each route assembles its own pipeline from shared stages.

| Route | Guard | Ingest | Model Transform | Execute | Deliver |
|---|---|---|---|---|---|
| `/v1/messages` | Yes | Anthropic parser | rewrite → beta → policy | 3 strategies | SSE/JSON |
| `/v1/chat/completions` | Yes | OpenAI parser | rewrite only | 1 strategy | SSE/JSON |
| `/v1/responses` | Yes | Responses parser | rewrite only | emulator/passthrough | SSE/JSON |
| `/v1/embeddings` | Yes | Embeddings parser | — | passthrough | JSON |
| `/v1/models` | No | — | — | return cache | JSON |

### Pipeline Stage Types

Each stage is a pure async function — no `next()` callback, no middleware chain. Stages compose by explicit sequential calls in each route handler.

```typescript
type IngestFn<T> = (raw: RawRequest) => Promise<IngestedRequest<T>>
type ModelTransformFn = (step: ModelTransformInput) => ModelTransformOutput
type ExecuteFn = (ctx: StrategyContext) => Promise<ExecutionResult>
type DeliverFn = (result: ExecutionResult, raw: RawRequest) => Response
```

### Shared Utilities

Eliminate handler duplication with:

- `withTranslationErrors(fn)` — wraps TranslationFailure try-catch (currently repeated 3x)
- `resolveModelOrThrow(modelId)` — model validation (currently repeated 4x)
- `createStrategyContext(input)` — client + signal initialization (currently repeated 3x)

## 2. Ingest Layer (Protocol Registry)

### Current Problem

Every handler repeats the same 2-step parse + normalize pattern inline.

### Design

```typescript
interface ProtocolHandler<TPayload = unknown> {
  parse: (body: unknown) => TPayload
  extractMeta: (payload: TPayload, headers: Headers) => RequestMeta
}

type ProtocolId
  = | 'anthropic-messages'
    | 'anthropic-count-tokens'
    | 'openai-chat'
    | 'responses'
    | 'embeddings'

class ProtocolRegistry {
  register<T>(id: ProtocolId, handler: ProtocolHandler<T>): void
  ingest<T>(id: ProtocolId, body: unknown, headers: Headers): IngestedRequest<T>
}
```

Each protocol registers a handler at startup. Existing Zod schemas and context extraction functions are reused — no new validation logic.

```typescript
interface IngestedRequest<TPayload = unknown> {
  protocol: ProtocolId
  payload: TPayload
  meta: RequestMeta
  raw: RawRequest
}

interface RequestMeta {
  sessionId?: string
  subagentInfo?: SubagentInfo
  betaHeaders?: string[]
}
```

## 3. Model Transform Chain

### Current Problem

3 handlers each inline model rewrite logic. `messages/handler.ts` has a 4-stage inline pipeline with if-else step tracking.

### Design

Each transform step implements a uniform interface:

```typescript
interface ModelTransformStep {
  readonly tag: string
  apply: (input: ModelTransformInput) => ModelTransformOutput | null
}

interface ModelTransformInput {
  model: string
  payload: unknown
  meta: RequestMeta
  resolvedModel?: Model
}

interface ModelTransformOutput {
  model: string
  resolvedModel?: Model
  mutatePayload?: (payload: unknown) => void
}
```

Steps compose into a chain:

```typescript
function composeModelTransforms(...steps: ModelTransformStep[]): ModelTransformChain

interface ModelTransformChain {
  apply: (input: ModelTransformInput) => ModelTransformResult
}

interface ModelTransformResult {
  model: string
  resolvedModel?: Model
  trace: Array<{ tag: string, from: string, to: string }>
}
```

### Built-in Steps

- **rewriteStep** — user rules + normalization (wraps existing `applyModelRewrite()`)
- **betaHeaderStep** — context-\*k betas → upgrade (wraps existing `processAnthropicBetaHeader()`)
- **modelPolicyStep** — context upgrade + compact routing (wraps existing `applyMessagesModelPolicy()`)

### Per-Route Assembly

```typescript
const messagesModelChain = composeModelTransforms(rewriteStep, betaHeaderStep, modelPolicyStep)
const chatCompletionsModelChain = composeModelTransforms(rewriteStep)
const responsesModelChain = composeModelTransforms(rewriteStep)
```

### Context Error Reactive Upgrade

Not part of the transform chain. Handled as a dispatch-level error recovery wrapper:

```typescript
async function executeWithContextRetry(
  executeFn: () => Promise<ExecutionResult>,
  modelInfo: ModelTransformResult,
): Promise<ExecutionResult>
```

## 4. Dispatch & Strategy

### ExecutionStrategy Interface

Preserved as-is — the current design is clean:

```typescript
interface ExecutionStrategy<TResult, TChunk> {
  execute: () => Promise<TResult>
  isStream: (result: TResult) => result is TResult & AsyncIterable<TChunk>
  translateResult: (result: TResult) => unknown
  translateStreamChunk: (chunk: TChunk) => SSEOutput | SSEOutput[] | null
  onStreamDone?: () => SSEOutput | SSEOutput[] | null
  onStreamError?: (error: unknown) => SSEOutput | SSEOutput[] | null
  shouldBreakStream?: (chunk: TChunk) => boolean
}
```

`runStrategy()` also preserved.

### Strategy Registry

Split the current 301-line `strategy-registry.ts` into pure registry mechanism + independent strategy files:

```typescript
interface StrategyEntry {
  name: string
  canHandle: (model: Model | undefined) => boolean
  createStrategy: (ctx: StrategyContext) => ExecutionStrategy<any, any>
}

class StrategyRegistry {
  register(entry: StrategyEntry): void
  select(model: Model | undefined): StrategyEntry
}
```

### StrategyContext (Eliminate Initialization Duplication)

```typescript
interface StrategyContext {
  payload: unknown
  modelInfo: ModelTransformResult
  meta: RequestMeta
  signal: AbortSignal
  copilotClient: CopilotClient
  upstreamSignal: AbortSignal
}

function createStrategyContext(input: { ... }): StrategyContext
```

### Emulator Branch Elimination

The 5 occurrences of `shouldUseResponsesOfficialEmulator()` become a single dispatch-level decision:

```typescript
interface ResourceDispatcher {
  retrieve: (id: string) => Promise<ResponseObject>
  listInputItems: (id: string, params: ListParams) => Promise<InputItems>
  createInputTokens: (id: string, payload: unknown) => Promise<TokenCount>
  delete: (id: string) => Promise<void>
}

function createResourceDispatcher(): ResourceDispatcher {
  return configStore.isEmulatorEnabled()
    ? new EmulatorResourceDispatcher()
    : new UpstreamResourceDispatcher()
}
```

### isStream() Unification

5 different implementations reduced to 2 standard patterns:

```typescript
// Pattern 1: result-based (most strategies)
function isAsyncIterableResult<T>(result: T): result is T & AsyncIterable<unknown>

// Pattern 2: payload.stream flag + result (responses-related)
function isStreamingRequest<T>(payload: { stream?: boolean }, result: T): boolean
```

## 5. Translate (Protocol-pair Translators)

### Design Principle

No shared IR. Each protocol pair has its own direct translator. Organized by **registry + trait**.

### Translator Trait

```typescript
interface ProtocolTranslator<TSource, TTarget, TSourceChunk, TTargetChunk> {
  translateRequest: (source: TSource, policy?: TranslationPolicy) => TTarget
  translateResponse: (target: unknown) => unknown
  createStreamTranslator: () => StreamTranslator<TSourceChunk, TTargetChunk>
}

interface StreamTranslator<TSourceChunk, TTargetChunk> {
  onChunk: (chunk: TSourceChunk) => TTargetChunk | TTargetChunk[] | null
  onDone: () => TTargetChunk | TTargetChunk[] | null
  onError?: (error: unknown) => TTargetChunk | TTargetChunk[] | null
}
```

### Translator Registry

```typescript
type TranslatorKey = `${ProtocolId}→${ProtocolId}`

class TranslatorRegistry {
  register(key: TranslatorKey, translator: ProtocolTranslator<any, any, any, any>): void
  get(key: TranslatorKey): ProtocolTranslator<any, any, any, any>
}
```

Registered pairs:

- `anthropic→openai-chat` — Anthropic Messages → OpenAI Chat Completions
- `openai-chat→anthropic` — OpenAI Chat → Anthropic Messages (response direction)
- `anthropic→responses` — Anthropic Messages → OpenAI Responses
- `responses→anthropic` — OpenAI Responses → Anthropic Messages (response direction)

### Block Handler Map (Eliminate 7 Switch Statements)

```typescript
type BlockHandlerMap<TBlock, TOutput> = Record<string, (block: TBlock) => TOutput | null>

function dispatchBlock<TBlock extends { type: string }, TOutput>(
  block: TBlock,
  handlers: BlockHandlerMap<TBlock, TOutput>,
  fallback?: (block: TBlock) => TOutput | null,
): TOutput | null
```

Each translator defines its own handler map declaratively. No switch statements. Adding a new block type is one line in the map.

### Semantic Mapping Tables (Extracted Constants)

Hardcoded mappings extracted to declarative constants in `translate/shared/`:

- `OPENAI_TO_ANTHROPIC_STOP_REASON` — stop/finish reason mapping
- `REASONING_EFFORT_THRESHOLDS` — thinking budget ↔ effort level
- `ANTHROPIC_TO_OPENAI_TOOL_CHOICE` — tool choice mapping (with documented semantic losses)

### Stream Block Manager (Shared Lifecycle)

```typescript
class StreamBlockManager<TEvent> {
  openBlock(type: string): TEvent[]
  appendDelta(index: number, delta: unknown): TEvent[]
  closeBlock(index: number): TEvent[]
  closeAllOpen(): TEvent[]
  getCurrentIndex(): number
}
```

Shared between `anthropic-openai/stream.ts` and `anthropic-responses/stream.ts`, eliminating ~50-65% of stream lifecycle duplication.

### TranslationPolicy Unification

All translators accept `TranslationPolicy` via the trait interface. No more "some translators have policy, some don't."

## 6. Deliver Layer

### Response Delivery

```typescript
type ExecutionResult
  = | { kind: 'json', data: unknown, status?: number }
    | { kind: 'stream', events: AsyncIterable<SSEOutput> }

function deliverResult(result: ExecutionResult, raw: RawRequest): Response
```

### Unified Error Formatting

```typescript
function formatErrorResponse(error: unknown): Response
// Handles: HTTPError, TranslationFailure, generic errors

function withTranslationErrors<T>(fn: () => T): T
// Replaces 3 identical try-catch blocks

function resolveModelOrThrow(modelId: string): Model
// Replaces 4 identical !selectedModel checks
```

## 7. State Decomposition

The global `AppState` god object splits into 5 independent stores:

### AuthStore

```typescript
class AuthStore {
  setGithubToken(token: string): void
  getCopilotToken(): string
  getCopilotApiBase(): string
  refreshCopilotToken(): Promise<void>
}
```

### ModelCache

```typescript
class ModelCache {
  cacheModels(models: ModelsResponse): void
  getModels(): ModelsResponse | undefined
  findById(id: string): Model | undefined
  supportsEndpoint(model: Model, endpoint: string): boolean
}
```

### ConfigStore

```typescript
class ConfigStore {
  // Feature flag queries (replaces 10+ scattered shouldUse*() functions)
  isEmulatorEnabled(): boolean
  isContextUpgradeEnabled(): boolean
  isCompactSmallModelEnabled(): boolean
  isFunctionApplyPatchEnabled(): boolean
  isAutoCompactResponsesInputEnabled(): boolean
  isContextManagementModel(model: string): boolean
  getSmallModel(): string | undefined
  getReasoningEffort(model: string): ReasoningEffort
  getContextUpgradeThreshold(): number
  getUpstreamQueueOptions(): QueueOptions
}
```

### RateLimiter

```typescript
class RateLimiter {
  async acquire(intervalMs: number, waitMode: boolean): Promise<void>
}
```

### EmulatorStore

Reuses existing `createResponsesEmulatorState()` logic, modularized as an independent store.

### Access Pattern

Stores are singleton instances exported from `state/index.ts`. Consumers import the specific store they need — no more `import { state }` that pulls in everything.

## 8. Directory Structure

```
src/
├── pipeline/                      # Pipeline framework
│   ├── types.ts                   #   Core types
│   ├── compose.ts                 #   Composition utilities
│   └── context.ts                 #   StrategyContext factory
│
├── guard/                         # Stage 1: Auth + rate limit
│   ├── auth.ts
│   └── rate-limit.ts
│
├── ingest/                        # Stage 2: Protocol parsing
│   ├── registry.ts
│   ├── anthropic-messages.ts
│   ├── anthropic-count-tokens.ts
│   ├── openai-chat.ts
│   ├── responses.ts
│   └── embeddings.ts
│
├── transform/                     # Stage 3: Model transforms
│   ├── chain.ts
│   ├── rewrite.ts
│   ├── beta-headers.ts
│   ├── policy.ts
│   ├── capabilities.ts
│   └── resolver.ts
│
├── dispatch/                      # Stage 4: Strategy + execution
│   ├── strategy-registry.ts
│   ├── strategy-runner.ts
│   ├── error-recovery.ts
│   ├── native-messages.ts
│   ├── responses-api.ts
│   ├── chat-completions.ts
│   ├── responses-passthrough.ts
│   ├── resource-dispatcher.ts
│   └── passthrough.ts
│
├── translate/                     # Translation modules
│   ├── registry.ts
│   ├── traits.ts
│   ├── anthropic-openai/
│   │   ├── request.ts
│   │   ├── response.ts
│   │   └── stream.ts
│   ├── anthropic-responses/
│   │   ├── request.ts
│   │   ├── response.ts
│   │   ├── stream.ts
│   │   └── signature-codec.ts
│   └── shared/
│       ├── block-handlers.ts
│       ├── stream-block-manager.ts
│       ├── stop-reason.ts
│       ├── thinking-budget.ts
│       ├── tool-choice.ts
│       └── usage.ts
│
├── deliver/                       # Stage 5: Response serialization
│   ├── response.ts
│   ├── sse.ts
│   ├── json.ts
│   └── error.ts
│
├── state/                         # Decomposed state stores
│   ├── index.ts
│   ├── auth.ts
│   ├── model-cache.ts
│   ├── config-store.ts
│   ├── rate-limiter.ts
│   └── emulator-store.ts
│
├── infra/                         # Cross-cutting infrastructure
│   ├── copilot-client.ts
│   ├── github-client.ts
│   ├── vscode-client.ts
│   ├── upstream-queue.ts
│   ├── upstream-signal.ts
│   ├── retry.ts
│   ├── logger.ts
│   ├── tokenizer.ts
│   └── error.ts
│
├── routes/                        # Thin Elysia route plugins
│   ├── messages.ts
│   ├── chat-completions.ts
│   ├── responses.ts
│   ├── embeddings.ts
│   ├── models.ts
│   ├── token.ts
│   └── usage.ts
│
├── types/
│   ├── copilot.ts
│   ├── responses.ts
│   ├── github.ts
│   └── index.ts
│
├── server.ts                      # Elysia app factory
├── start.ts                       # Bootstrap
├── main.ts                        # CLI entry
├── auth.ts                        # CLI: auth command
├── check-usage.ts                 # CLI: check-usage command
└── debug.ts                       # CLI: debug command
```

### Route Simplification

Each route file becomes a thin delegation layer (~20 lines) that composes shared stages:

```typescript
// routes/messages.ts
export const messagesRoute = new Elysia()
  .post('/v1/messages', async ({ body, headers, request }) => {
    const raw = { body, headers, signal: request.signal }
    await runGuard(raw)
    const ingested = protocolRegistry.ingest('anthropic-messages', raw)
    const transformed = messagesModelChain.apply(ingested)
    const ctx = createStrategyContext(transformed)
    const strategy = strategyRegistry.select(ctx.modelInfo.resolvedModel)
    const result = await executeWithContextRetry(
      () => runStrategy(strategy.createStrategy(ctx)),
      ctx.modelInfo,
    )
    return deliverResult(result, raw)
  })
```

### File Count Comparison

| Area | Before | After |
|---|---|---|
| Total files | ~112 | ~65-70 |
| routes/ | ~30 | ~7 |
| translator/ | ~18 | ~10 |
| lib/ | ~36 | 0 (distributed to stages) |

## 9. Migration Strategy

### Key Principles

- **Existing Zod schemas reused** — no new validation logic
- **Existing functions wrapped** — transform steps wrap `applyModelRewrite()` etc., not rewrite
- **Tests adapted, not rewritten** — test helpers updated for new imports, assertions unchanged
- **External contracts unchanged** — API, CLI, config.json all backward compatible

### Migration Order

1. **State decomposition** — extract stores from `state.ts` (foundation for everything else)
2. **Pipeline framework** — create `pipeline/`, `deliver/`, `guard/` infrastructure
3. **Ingest layer** — create ProtocolRegistry, register existing parsers
4. **Transform layer** — create ModelTransformChain, wrap existing functions as steps
5. **Dispatch layer** — split strategy-registry, extract StrategyContext, ResourceDispatcher
6. **Translate layer** — reorganize translators by protocol pair, add registries + shared modules
7. **Route simplification** — rewrite route files as thin pipeline composers
8. **Cleanup** — remove empty `lib/`, `adapters/`, `core/`, old route subdirectories

Each phase should end with all tests passing (`bun run lint:all && bun run typecheck && bun run build && bun test`).
