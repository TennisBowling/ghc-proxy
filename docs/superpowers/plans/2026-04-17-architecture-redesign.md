# Architecture Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure ghc-proxy internals around a pipeline-stage-based architecture with composable transforms, protocol registries, and decomposed state — without changing any external contracts.

**Architecture:** Request flow through typed pipeline stages (guard → ingest → transform → dispatch → translate → deliver). Protocol-specific behavior via registries. State split into focused stores. Routes become thin pipeline composers.

**Tech Stack:** TypeScript (ESNext strict), Elysia, Zod, Bun test runner

**Spec:** `docs/superpowers/specs/2026-04-17-architecture-redesign-design.md`

**Validation command (run after every phase):**

```bash
bun run lint:all && bun run typecheck && bun run build && bun test
```

---

## Phase 1: State Decomposition

Split the global `AppState` god object into 5 focused stores. This is the foundation — everything else depends on it.

### Task 1: Create ConfigStore

Extract all `shouldUse*()` / `get*()` config query functions from `src/lib/config.ts` into a class.

**Files:**
- Create: `src/state/config-store.ts`
- Modify: `src/lib/config.ts` (re-export from new location)

- [ ] **Step 1: Create `src/state/config-store.ts`**

```typescript
import type { ConfigFile } from '~/lib/config'

import { readConfig } from '~/lib/config'

export type { ReasoningEffort } from '~/lib/config'

export class ConfigStore {
  private config: Partial<ConfigFile> = {}

  async load(): Promise<void> {
    this.config = await readConfig()
  }

  getConfig(): Partial<ConfigFile> {
    return this.config
  }

  isEmulatorEnabled(): boolean {
    return this.config.responsesOfficialEmulator === true
  }

  getEmulatorTtlSeconds(): number {
    return this.config.responsesOfficialEmulatorTtlSeconds ?? 14400
  }

  isContextUpgradeEnabled(): boolean {
    return this.config.contextUpgrade !== false
  }

  getContextUpgradeThreshold(): number {
    return this.config.contextUpgradeTokenThreshold ?? 160_000
  }

  isCompactSmallModelEnabled(): boolean {
    return this.config.compactUseSmallModel === true
  }

  getSmallModel(): string | undefined {
    return this.config.smallModel ?? undefined
  }

  isFunctionApplyPatchEnabled(): boolean {
    return this.config.useFunctionApplyPatch === true
  }

  isAutoCompactResponsesInputEnabled(): boolean {
    return this.config.responsesApiAutoCompactInput === true
  }

  isContextManagementEnabled(): boolean {
    return this.config.responsesApiAutoContextManagement === true
  }

  isContextManagementModel(model: string): boolean {
    const models = this.config.responsesApiContextManagementModels
    return Array.isArray(models) && models.includes(model)
  }

  getReasoningEffort(model: string): string {
    return this.config.modelReasoningEfforts?.[model] ?? 'high'
  }

  getModelRewrites(): Array<{ from: string, to: string }> {
    return this.config.modelRewrites ?? []
  }

  getModelFallback(): Partial<{ claudeOpus: string, claudeSonnet: string, claudeHaiku: string }> {
    return this.config.modelFallback ?? {}
  }

  getUpstreamQueueConcurrency(): number | undefined {
    return this.config.upstreamQueueConcurrency
  }

  getUpstreamQueueMaxRetries(): number | undefined {
    return this.config.upstreamQueueMaxRetries
  }

  getUpstreamQueueBaseDelaySeconds(): number | undefined {
    return this.config.upstreamQueueBaseDelaySeconds
  }

  getUpstreamQueueMaxDelaySeconds(): number | undefined {
    return this.config.upstreamQueueMaxDelaySeconds
  }
}

export const configStore = new ConfigStore()
```

- [ ] **Step 2: Add backward-compatible re-exports in `src/lib/config.ts`**

At the bottom of `src/lib/config.ts`, add:

```typescript
export { configStore } from '~/state/config-store'
```

Keep all existing `shouldUse*()` / `get*()` functions — they will be removed in Phase 8 after all consumers migrate.

- [ ] **Step 3: Create `src/state/index.ts`**

```typescript
export { configStore } from './config-store'
export type { ReasoningEffort } from './config-store'
```

- [ ] **Step 4: Run validation**

```bash
bun run lint:all && bun run typecheck && bun run build && bun test
```

- [ ] **Step 5: Commit**

```bash
git add src/state/config-store.ts src/state/index.ts src/lib/config.ts
git commit -m "refactor: extract ConfigStore from config.ts"
```

---

### Task 2: Create ModelCache

Extract model cache and capability queries from `src/lib/state.ts` and `src/lib/model-capabilities.ts`.

**Files:**
- Create: `src/state/model-cache.ts`
- Modify: `src/state/index.ts`

- [ ] **Step 1: Create `src/state/model-cache.ts`**

```typescript
import type { Model, ModelsResponse } from '~/types'

export const RESPONSES_ENDPOINT = '/v1/responses'
export const MESSAGES_ENDPOINT = '/v1/messages'

const MODELS_REJECTING_OUTPUT_CONFIG = new Set([
  'claude-sonnet-4',
  'claude-sonnet-4.5',
  'claude-haiku-4.5',
])

export class ModelCache {
  private models?: ModelsResponse
  private vsCodeVersion?: string

  cacheModels(models: ModelsResponse): void {
    this.models = models
  }

  getModels(): ModelsResponse | undefined {
    return this.models
  }

  setVSCodeVersion(version: string): void {
    this.vsCodeVersion = version
  }

  getVSCodeVersion(): string | undefined {
    return this.vsCodeVersion
  }

  findById(modelId: string): Model | undefined {
    return this.models?.data.find(m => m.id === modelId)
  }

  getModelIds(): Set<string> {
    return new Set(this.models?.data.map(m => m.id) ?? [])
  }

  supportsEndpoint(model: Model, endpoint: string): boolean {
    return model.capabilities?.supported_endpoints?.includes(endpoint) ?? false
  }

  supportsToolCalls(model: Model): boolean {
    return model.capabilities?.supports?.tool_calls === true
  }

  supportsAdaptiveThinking(model: Model): boolean {
    return model.capabilities?.supports?.adaptive_thinking === true
  }

  supportsVision(model: Model): boolean {
    return model.capabilities?.supports?.vision === true
  }

  supportsOutputConfig(model: Model): boolean {
    return !MODELS_REJECTING_OUTPUT_CONFIG.has(model.id)
  }

  getVisionLimits(model: Model): { maxTokens?: number, maxImages?: number } {
    return {
      maxTokens: model.capabilities?.limits?.vision?.max_prompt_tokens,
      maxImages: model.capabilities?.limits?.vision?.max_images_per_request,
    }
  }
}

export const modelCache = new ModelCache()
```

- [ ] **Step 2: Update `src/state/index.ts`**

Add:

```typescript
export { modelCache, RESPONSES_ENDPOINT, MESSAGES_ENDPOINT } from './model-cache'
```

- [ ] **Step 3: Run validation**

```bash
bun run lint:all && bun run typecheck && bun run build && bun test
```

- [ ] **Step 4: Commit**

```bash
git add src/state/model-cache.ts src/state/index.ts
git commit -m "refactor: extract ModelCache from state.ts and model-capabilities.ts"
```

---

### Task 3: Create AuthStore and RateLimiter

Extract auth state from `src/lib/state.ts` and rate limit from `src/lib/rate-limit.ts`.

**Files:**
- Create: `src/state/auth.ts`
- Create: `src/state/rate-limiter.ts`
- Modify: `src/state/index.ts`

- [ ] **Step 1: Create `src/state/auth.ts`**

```typescript
export class AuthStore {
  githubToken?: string
  copilotToken?: string
  copilotApiBase?: string
  gheDomain?: string
  accountType: 'individual' | 'business' | 'enterprise' = 'individual'
  manualApprove = false
  rateLimitSeconds?: number
  rateLimitWait = false
  showToken = false
  upstreamTimeoutSeconds?: number
}

export const authStore = new AuthStore()
```

- [ ] **Step 2: Create `src/state/rate-limiter.ts`**

```typescript
import { HTTPError } from '~/lib/error'
import { sleep } from '~/lib/sleep'

export class RateLimiter {
  private nextAvailableAt = 0

  async acquire(intervalSeconds: number | undefined, waitMode: boolean): Promise<void> {
    if (!intervalSeconds) return

    const intervalMs = intervalSeconds * 1000
    const now = Date.now()

    if (this.nextAvailableAt === 0) {
      this.nextAvailableAt = now + intervalMs
      return
    }

    if (now >= this.nextAvailableAt) {
      this.nextAvailableAt = now + intervalMs
      return
    }

    const claimedSlot = this.nextAvailableAt
    this.nextAvailableAt = claimedSlot + intervalMs

    if (!waitMode) {
      const retryAfterSeconds = Math.ceil((claimedSlot - now) / 1000)
      throw new HTTPError(429, {
        error: {
          message: `Rate limited. Try again in ${retryAfterSeconds}s or use --wait flag.`,
          type: 'rate_limit_error',
        },
      })
    }

    const waitMs = claimedSlot - now
    if (waitMs > 0) {
      await sleep(waitMs)
    }
  }
}

export const rateLimiter = new RateLimiter()
```

- [ ] **Step 3: Create `src/state/emulator-store.ts`**

Re-export the existing emulator state (it's already well-encapsulated):

```typescript
export { responsesEmulatorState } from '~/lib/responses-emulator-state'
export type { ResponsesEmulatorState } from '~/lib/responses-emulator-state'
```

- [ ] **Step 4: Update `src/state/index.ts`**

```typescript
export { configStore } from './config-store'
export type { ReasoningEffort } from './config-store'
export { modelCache, RESPONSES_ENDPOINT, MESSAGES_ENDPOINT } from './model-cache'
export { authStore } from './auth'
export { rateLimiter } from './rate-limiter'
export { responsesEmulatorState } from './emulator-store'
```

- [ ] **Step 5: Run validation**

```bash
bun run lint:all && bun run typecheck && bun run build && bun test
```

- [ ] **Step 6: Commit**

```bash
git add src/state/
git commit -m "refactor: extract AuthStore, RateLimiter, and EmulatorStore"
```

---

### Task 4: Migrate consumers to new state imports

Update all files that import from `~/lib/state`, `~/lib/config`, `~/lib/model-capabilities`, and `~/lib/rate-limit` to use the new `~/state` imports instead. Keep old files as re-export shims until Phase 8.

**Files:**
- Modify: `src/lib/state.ts` (make it re-export from `~/state`)
- Modify: `src/lib/model-capabilities.ts` (re-export from `~/state`)
- Modify: `src/lib/rate-limit.ts` (re-export from `~/state`)
- Modify: All consumer files (update imports)

- [ ] **Step 1: Find all consumers**

```bash
rg "from '~/lib/state'" src/ --files-with-matches
rg "from '~/lib/config'" src/ --files-with-matches
rg "from '~/lib/model-capabilities'" src/ --files-with-matches
rg "from '~/lib/rate-limit'" src/ --files-with-matches
```

- [ ] **Step 2: Update `src/lib/state.ts` to delegate to new stores**

Replace the `state` object body to use the new stores internally, while keeping the same export shape for unconverted consumers:

```typescript
import { authStore } from '~/state'
import { modelCache } from '~/state'
import { rateLimiter } from '~/state'
import { responsesEmulatorState } from '~/state'

// Legacy AppState shape — consumers should migrate to ~/state imports
export const state = {
  get auth() { return authStore },
  config: authStore,
  cache: {
    get models() { return modelCache.getModels() },
    set models(v) { if (v) modelCache.cacheModels(v) },
    get vsCodeVersion() { return modelCache.getVSCodeVersion() },
    set vsCodeVersion(v) { if (v) modelCache.setVSCodeVersion(v) },
  },
  rateLimit: { nextAvailableAt: 0 },
  responsesEmulator: responsesEmulatorState,
}
```

Note: This step requires careful testing. The legacy `state` object must behave identically. If the proxy shape causes issues, keep the original `state` object unchanged and only add new exports — migrating consumers file-by-file is safer.

**Safer alternative:** Keep `src/lib/state.ts` unchanged. Update consumers one file at a time to import from `~/state` instead. This avoids breaking the legacy shape. Proceed with this approach.

- [ ] **Step 3: Update consumer imports batch by batch**

For each consumer file, replace:
- `import { state } from '~/lib/state'` → import specific stores from `~/state`
- `state.cache.models` → `modelCache.getModels()`
- `state.auth.copilotToken` → `authStore.copilotToken`
- `shouldUseResponsesOfficialEmulator()` → `configStore.isEmulatorEnabled()`
- `findModelById(id)` → `modelCache.findById(id)`
- `modelSupportsEndpoint(m, e)` → `modelCache.supportsEndpoint(m, e)`
- `checkRateLimit(state)` → `rateLimiter.acquire(authStore.rateLimitSeconds, authStore.rateLimitWait)`

Update files in small batches, running tests after each batch:

**Batch 1:** Route handlers (`src/routes/*/handler.ts`, `src/routes/*/strategy.ts`)
**Batch 2:** Strategy registry (`src/routes/messages/strategy-registry.ts`)
**Batch 3:** Lib modules (`src/lib/model-rewrite.ts`, `src/lib/request-model-policy.ts`, `src/lib/token.ts`)
**Batch 4:** Clients and adapters (`src/clients/`, `src/adapters/`)
**Batch 5:** Test helpers (`tests/helpers.ts`)

- [ ] **Step 4: Run validation after each batch**

```bash
bun run lint:all && bun run typecheck && bun run build && bun test
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: migrate consumers to new state stores"
```

---

## Phase 2: Pipeline Framework + Deliver Layer

Create the shared pipeline utilities and delivery layer.

### Task 5: Create Deliver Layer

Extract response delivery, error formatting, and shared utilities.

**Files:**
- Create: `src/deliver/response.ts`
- Create: `src/deliver/sse.ts`
- Create: `src/deliver/error.ts`

- [ ] **Step 1: Create `src/deliver/error.ts`**

```typescript
import type { Model } from '~/types'

import { modelCache } from '~/state'
import { HTTPError, throwInvalidRequestError } from '~/lib/error'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'
import { fromTranslationFailure } from '~/lib/error'

export function resolveModelOrThrow(modelId: string): Model {
  const model = modelCache.findById(modelId)
  if (!model) {
    throwInvalidRequestError('The selected model could not be resolved.', 'model')
  }
  return model!
}

export function withTranslationErrors<T>(fn: () => T): T {
  try {
    return fn()
  }
  catch (error) {
    if (error instanceof TranslationFailure) {
      throw fromTranslationFailure(error)
    }
    throw error
  }
}

export function formatErrorResponse(error: unknown): Response {
  if (error instanceof HTTPError) {
    return error.toResponse()
  }
  if (error instanceof TranslationFailure) {
    const httpError = fromTranslationFailure(error)
    return new Response(JSON.stringify(httpError.body), {
      status: httpError.status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return new Response(
    JSON.stringify({ error: { message: 'Internal server error', type: 'server_error' } }),
    { status: 500, headers: { 'content-type': 'application/json' } },
  )
}
```

- [ ] **Step 2: Create `src/deliver/sse.ts`**

Move and re-export the existing SSE adapter:

```typescript
export { sseAdapter } from '~/lib/sse-adapter'
```

- [ ] **Step 3: Create `src/deliver/response.ts`**

```typescript
import type { ExecutionResult } from '~/lib/execution-strategy'

export type { ExecutionResult } from '~/lib/execution-strategy'

export { runStrategy } from '~/lib/execution-strategy'
```

- [ ] **Step 4: Create `src/deliver/index.ts`**

```typescript
export { resolveModelOrThrow, withTranslationErrors, formatErrorResponse } from './error'
export { sseAdapter } from './sse'
export { runStrategy } from './response'
export type { ExecutionResult } from './response'
```

- [ ] **Step 5: Run validation**

```bash
bun run lint:all && bun run typecheck && bun run build && bun test
```

- [ ] **Step 6: Commit**

```bash
git add src/deliver/
git commit -m "refactor: create deliver layer with error utilities"
```

---

### Task 6: Create Pipeline Context

Create the shared StrategyContext factory that eliminates client+signal initialization duplication.

**Files:**
- Create: `src/pipeline/context.ts`
- Create: `src/pipeline/index.ts`

- [ ] **Step 1: Create `src/pipeline/context.ts`**

```typescript
import type { CopilotClient } from '~/clients'
import type { ModelTransformResult } from '~/pipeline/types'
import type { RequestMeta } from '~/ingest/types'

import { createCopilotClient } from '~/lib/state'
import { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'

export interface StrategyContext {
  payload: unknown
  modelInfo: ModelTransformResult
  meta: RequestMeta
  signal: AbortSignal
  copilotClient: CopilotClient
  upstreamSignal: ReturnType<typeof createUpstreamSignalFromConfig>
  headers: Headers
}

export function createStrategyContext(input: {
  payload: unknown
  modelInfo: ModelTransformResult
  meta: RequestMeta
  signal: AbortSignal
  headers: Headers
}): StrategyContext {
  return {
    ...input,
    copilotClient: createCopilotClient(),
    upstreamSignal: createUpstreamSignalFromConfig(input.signal),
  }
}
```

- [ ] **Step 2: Create `src/pipeline/types.ts`**

```typescript
export interface ModelTransformRecord {
  tag: string
  from: string
  to: string
}

export interface ModelTransformResult {
  model: string
  resolvedModel?: import('~/types').Model
  trace: ModelTransformRecord[]
}

export interface RawRequest {
  body: unknown
  headers: Headers
  signal: AbortSignal
}
```

- [ ] **Step 3: Create `src/pipeline/index.ts`**

```typescript
export { createStrategyContext } from './context'
export type { StrategyContext } from './context'
export type { ModelTransformResult, ModelTransformRecord, RawRequest } from './types'
```

- [ ] **Step 4: Run validation**

```bash
bun run lint:all && bun run typecheck && bun run build && bun test
```

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/
git commit -m "refactor: create pipeline framework with StrategyContext"
```

---

## Phase 3: Ingest Layer

### Task 7: Create Protocol Registry

Create the protocol registry and register all existing parsers.

**Files:**
- Create: `src/ingest/types.ts`
- Create: `src/ingest/registry.ts`
- Create: `src/ingest/anthropic-messages.ts`
- Create: `src/ingest/openai-chat.ts`
- Create: `src/ingest/responses.ts`
- Create: `src/ingest/embeddings.ts`
- Create: `src/ingest/index.ts`

- [ ] **Step 1: Create `src/ingest/types.ts`**

```typescript
export type ProtocolId =
  | 'anthropic-messages'
  | 'anthropic-count-tokens'
  | 'openai-chat'
  | 'responses'
  | 'responses-input-tokens'
  | 'embeddings'

export interface RequestMeta {
  sessionId?: string
  subagentInfo?: unknown
  betaHeaders?: string[]
  requestContext?: unknown
}

export interface ProtocolHandler<TPayload = unknown> {
  parse(body: unknown): TPayload
  extractMeta(payload: TPayload, headers: Headers): RequestMeta
}

export interface IngestedRequest<TPayload = unknown> {
  protocol: ProtocolId
  payload: TPayload
  meta: RequestMeta
}
```

- [ ] **Step 2: Create `src/ingest/registry.ts`**

```typescript
import type { IngestedRequest, ProtocolHandler, ProtocolId } from './types'

export class ProtocolRegistry {
  private handlers = new Map<ProtocolId, ProtocolHandler>()

  register<T>(id: ProtocolId, handler: ProtocolHandler<T>): void {
    this.handlers.set(id, handler as ProtocolHandler)
  }

  ingest<T>(id: ProtocolId, body: unknown, headers: Headers): IngestedRequest<T> {
    const handler = this.handlers.get(id)
    if (!handler) {
      throw new Error(`No protocol handler registered for: ${id}`)
    }
    const payload = handler.parse(body) as T
    const meta = handler.extractMeta(payload, headers)
    return { protocol: id, payload, meta }
  }
}

export const protocolRegistry = new ProtocolRegistry()
```

- [ ] **Step 3: Create protocol handlers**

`src/ingest/anthropic-messages.ts`:

```typescript
import type { ProtocolHandler } from './types'
import type { AnthropicMessagesPayload } from '~/translator'

import { parseAnthropicMessagesPayload, parseAnthropicCountTokensPayload } from '~/lib/validation'
import { normalizeAnthropicRequestContext } from '~/core/capi'

export const anthropicMessagesProtocol: ProtocolHandler<AnthropicMessagesPayload> = {
  parse: parseAnthropicMessagesPayload,
  extractMeta(payload, headers) {
    const ctx = normalizeAnthropicRequestContext(payload, headers)
    return { requestContext: ctx }
  },
}

export const anthropicCountTokensProtocol: ProtocolHandler = {
  parse: parseAnthropicCountTokensPayload,
  extractMeta(payload, headers) {
    const ctx = normalizeAnthropicRequestContext(payload, headers)
    return { requestContext: ctx }
  },
}
```

`src/ingest/openai-chat.ts`:

```typescript
import type { ProtocolHandler } from './types'

import { parseOpenAIChatPayload } from '~/lib/validation'
import { normalizeChatRequestContext } from '~/core/capi'

export const openaiChatProtocol: ProtocolHandler = {
  parse: parseOpenAIChatPayload,
  extractMeta(payload, headers) {
    const ctx = normalizeChatRequestContext(payload, headers)
    return { requestContext: ctx }
  },
}
```

`src/ingest/responses.ts`:

```typescript
import type { ProtocolHandler } from './types'

import { parseResponsesPayload, parseResponsesInputTokensPayload } from '~/lib/validation'
import { normalizeResponsesRequestContext } from '~/core/capi'

export const responsesProtocol: ProtocolHandler = {
  parse: parseResponsesPayload,
  extractMeta(payload, headers) {
    const ctx = normalizeResponsesRequestContext(payload, headers)
    return { requestContext: ctx }
  },
}

export const responsesInputTokensProtocol: ProtocolHandler = {
  parse: parseResponsesInputTokensPayload,
  extractMeta(payload, headers) {
    const ctx = normalizeResponsesRequestContext(payload, headers)
    return { requestContext: ctx }
  },
}
```

`src/ingest/embeddings.ts`:

```typescript
import type { ProtocolHandler } from './types'

import { parseEmbeddingRequest } from '~/lib/validation'

export const embeddingsProtocol: ProtocolHandler = {
  parse: parseEmbeddingRequest,
  extractMeta() {
    return {}
  },
}
```

- [ ] **Step 4: Create `src/ingest/index.ts` with registry initialization**

```typescript
import { protocolRegistry } from './registry'
import { anthropicMessagesProtocol, anthropicCountTokensProtocol } from './anthropic-messages'
import { openaiChatProtocol } from './openai-chat'
import { responsesProtocol, responsesInputTokensProtocol } from './responses'
import { embeddingsProtocol } from './embeddings'

protocolRegistry.register('anthropic-messages', anthropicMessagesProtocol)
protocolRegistry.register('anthropic-count-tokens', anthropicCountTokensProtocol)
protocolRegistry.register('openai-chat', openaiChatProtocol)
protocolRegistry.register('responses', responsesProtocol)
protocolRegistry.register('responses-input-tokens', responsesInputTokensProtocol)
protocolRegistry.register('embeddings', embeddingsProtocol)

export { protocolRegistry } from './registry'
export type { ProtocolId, RequestMeta, IngestedRequest, ProtocolHandler } from './types'
```

- [ ] **Step 5: Run validation**

```bash
bun run lint:all && bun run typecheck && bun run build && bun test
```

- [ ] **Step 6: Commit**

```bash
git add src/ingest/
git commit -m "refactor: create protocol registry with all protocol handlers"
```

---

## Phase 4: Transform Layer

### Task 8: Create Model Transform Chain

Extract model rewrite, beta headers, and policy into composable transform steps.

**Files:**
- Create: `src/transform/types.ts`
- Create: `src/transform/chain.ts`
- Create: `src/transform/rewrite.ts`
- Create: `src/transform/beta-headers.ts`
- Create: `src/transform/policy.ts`
- Create: `src/transform/index.ts`

- [ ] **Step 1: Create `src/transform/types.ts`**

```typescript
import type { Model } from '~/types'
import type { RequestMeta } from '~/ingest/types'
import type { ModelTransformRecord, ModelTransformResult } from '~/pipeline/types'

export interface ModelTransformInput {
  model: string
  payload: unknown
  meta: RequestMeta
  resolvedModel?: Model
  headers?: Headers
}

export interface ModelTransformOutput {
  model: string
  resolvedModel?: Model
  tag?: string
  mutatePayload?: (payload: unknown) => void
}

export interface ModelTransformStep {
  readonly tag: string
  apply(input: ModelTransformInput): ModelTransformOutput | null
}

export type { ModelTransformRecord, ModelTransformResult }
```

- [ ] **Step 2: Create `src/transform/chain.ts`**

```typescript
import type { ModelTransformInput, ModelTransformStep } from './types'
import type { ModelTransformResult } from '~/pipeline/types'

import { modelCache } from '~/state'

export interface ModelTransformChain {
  apply(input: ModelTransformInput): ModelTransformResult
}

export function composeModelTransforms(...steps: ModelTransformStep[]): ModelTransformChain {
  return {
    apply(input: ModelTransformInput): ModelTransformResult {
      let currentModel = input.model
      let currentResolved = input.resolvedModel
      const trace: ModelTransformResult['trace'] = []

      for (const step of steps) {
        const output = step.apply({
          ...input,
          model: currentModel,
          resolvedModel: currentResolved,
        })
        if (output) {
          trace.push({
            tag: output.tag ?? step.tag,
            from: currentModel,
            to: output.model,
          })
          output.mutatePayload?.(input.payload)
          currentModel = output.model
          currentResolved = output.resolvedModel ?? modelCache.findById(output.model) ?? currentResolved
        }
      }

      return {
        model: currentModel,
        resolvedModel: currentResolved ?? modelCache.findById(currentModel),
        trace,
      }
    },
  }
}
```

- [ ] **Step 3: Create `src/transform/rewrite.ts`**

```typescript
import type { ModelTransformStep } from './types'

import { applyModelRewrite } from '~/lib/model-rewrite'

export const rewriteStep: ModelTransformStep = {
  tag: 'REWRITE',
  apply({ payload }) {
    const result = applyModelRewrite(payload)
    if (!result.reason) return null
    return {
      model: result.model,
      tag: result.reason,
    }
  },
}
```

- [ ] **Step 4: Create `src/transform/beta-headers.ts`**

```typescript
import type { ModelTransformStep } from './types'

import { processAnthropicBetaHeader } from '~/routes/messages/handler'

export const betaHeaderStep: ModelTransformStep = {
  tag: 'BETA_UPGRADE',
  apply({ model, headers }) {
    if (!headers) return null
    const betaHeader = headers.get('anthropic-beta') ?? undefined
    const result = processAnthropicBetaHeader(betaHeader, model)
    if (!result.upgradeTarget) return null
    return {
      model: result.upgradeTarget,
      mutatePayload(payload: unknown) {
        if (payload && typeof payload === 'object' && 'model' in payload) {
          ;(payload as Record<string, unknown>).model = result.upgradeTarget
        }
      },
    }
  },
}
```

- [ ] **Step 5: Create `src/transform/policy.ts`**

```typescript
import type { ModelTransformStep } from './types'

import { applyMessagesModelPolicy } from '~/lib/request-model-policy'

export const modelPolicyStep: ModelTransformStep = {
  tag: 'POLICY',
  apply({ model, payload, meta }) {
    const betaUpgraded = meta?.betaHeaders?.some(b => /^context-\d+[km]-/.test(b)) ?? false
    const routing = applyMessagesModelPolicy(payload, model, { betaUpgraded })
    if (!routing.reason) return null
    return {
      model: routing.routedModel,
      tag: routing.reason === 'context-upgrade' ? 'CONTEXT_UPGRADE' : 'COMPACT',
    }
  },
}
```

- [ ] **Step 6: Create `src/transform/index.ts`**

```typescript
export { composeModelTransforms } from './chain'
export type { ModelTransformChain } from './chain'
export { rewriteStep } from './rewrite'
export { betaHeaderStep } from './beta-headers'
export { modelPolicyStep } from './policy'
export type { ModelTransformStep, ModelTransformInput, ModelTransformOutput } from './types'

import { composeModelTransforms } from './chain'
import { rewriteStep } from './rewrite'
import { betaHeaderStep } from './beta-headers'
import { modelPolicyStep } from './policy'

export const messagesModelChain = composeModelTransforms(
  rewriteStep,
  betaHeaderStep,
  modelPolicyStep,
)

export const chatCompletionsModelChain = composeModelTransforms(
  rewriteStep,
)

export const responsesModelChain = composeModelTransforms(
  rewriteStep,
)
```

- [ ] **Step 7: Run validation**

```bash
bun run lint:all && bun run typecheck && bun run build && bun test
```

- [ ] **Step 8: Commit**

```bash
git add src/transform/
git commit -m "refactor: create composable model transform chain"
```

---

## Phase 5: Dispatch Layer

### Task 9: Create Strategy Registry Mechanism

Extract the pure registry mechanism from `src/routes/messages/strategy-registry.ts`.

**Files:**
- Create: `src/dispatch/strategy-registry.ts`
- Create: `src/dispatch/strategy-runner.ts`
- Create: `src/dispatch/error-recovery.ts`
- Create: `src/dispatch/index.ts`

- [ ] **Step 1: Create `src/dispatch/strategy-registry.ts`**

```typescript
import type { Model } from '~/types'
import type { ExecutionStrategy } from '~/lib/execution-strategy'
import type { StrategyContext } from '~/pipeline/context'

import consola from 'consola'

export interface StrategyEntry {
  name: string
  canHandle(model: Model | undefined): boolean
  createStrategy(ctx: StrategyContext): ExecutionStrategy<any, any>
}

export class StrategyRegistry {
  private entries: StrategyEntry[] = []

  register(entry: StrategyEntry): void {
    this.entries.push(entry)
  }

  select(model: Model | undefined): StrategyEntry {
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

- [ ] **Step 2: Create `src/dispatch/strategy-runner.ts`**

Re-export the existing `runStrategy` (already clean):

```typescript
export { runStrategy, normalizeOutputs, passthroughSSEChunk } from '~/lib/execution-strategy'
export type { ExecutionStrategy, ExecutionResult, SSEOutput, SSEStreamChunk } from '~/lib/execution-strategy'
```

- [ ] **Step 3: Create `src/dispatch/error-recovery.ts`**

```typescript
import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ModelTransformResult } from '~/pipeline/types'

import consola from 'consola'
import { isContextLengthError, getContextUpgradeTarget } from '~/lib/model-rewrite'

export async function executeWithContextRetry(
  executeFn: (model: string) => Promise<ExecutionResult>,
  modelInfo: ModelTransformResult,
): Promise<ExecutionResult> {
  try {
    return await executeFn(modelInfo.model)
  }
  catch (error) {
    if (!isContextLengthError(error)) throw error
    const upgradeTarget = getContextUpgradeTarget(modelInfo.model)
    if (!upgradeTarget) throw error
    consola.info(`Context length error → retrying with ${upgradeTarget}`)
    return await executeFn(upgradeTarget)
  }
}
```

- [ ] **Step 4: Create `src/dispatch/index.ts`**

```typescript
export { StrategyRegistry } from './strategy-registry'
export type { StrategyEntry } from './strategy-registry'
export { runStrategy, passthroughSSEChunk } from './strategy-runner'
export type { ExecutionStrategy, ExecutionResult, SSEOutput, SSEStreamChunk } from './strategy-runner'
export { executeWithContextRetry } from './error-recovery'
```

- [ ] **Step 5: Run validation**

```bash
bun run lint:all && bun run typecheck && bun run build && bun test
```

- [ ] **Step 6: Commit**

```bash
git add src/dispatch/
git commit -m "refactor: create dispatch layer with strategy registry and error recovery"
```

---

### Task 10: Create ResourceDispatcher

Eliminate 4x `shouldUseResponsesOfficialEmulator()` branches in resource-handler.

**Files:**
- Create: `src/dispatch/resource-dispatcher.ts`

- [ ] **Step 1: Create `src/dispatch/resource-dispatcher.ts`**

```typescript
import type { CopilotClient } from '~/clients'
import type { ResponsesResult } from '~/types/responses'

import { configStore } from '~/state'
import { createCopilotClient } from '~/lib/state'
import {
  getStoredResponseOrThrow,
  listStoredInputItemsOrThrow,
  estimateEmulatorInputTokens,
  deleteStoredResponseOrThrow,
} from '~/routes/responses/emulator'

export interface ResourceDispatcher {
  retrieve(responseId: string, params: Record<string, unknown>): Promise<unknown>
  listInputItems(responseId: string, params: Record<string, unknown>): Promise<unknown>
  createInputTokens(responseId: string, payload: unknown, model: string): Promise<unknown>
  delete(responseId: string): Promise<unknown>
}

class EmulatorResourceDispatcher implements ResourceDispatcher {
  async retrieve(responseId: string): Promise<unknown> {
    return getStoredResponseOrThrow(responseId)
  }

  async listInputItems(responseId: string, params: Record<string, unknown>): Promise<unknown> {
    return listStoredInputItemsOrThrow(responseId, params)
  }

  async createInputTokens(responseId: string, payload: unknown, model: string): Promise<unknown> {
    return estimateEmulatorInputTokens(responseId, payload, model)
  }

  async delete(responseId: string): Promise<unknown> {
    return deleteStoredResponseOrThrow(responseId)
  }
}

class UpstreamResourceDispatcher implements ResourceDispatcher {
  private client: CopilotClient

  constructor() {
    this.client = createCopilotClient()
  }

  async retrieve(responseId: string, params: Record<string, unknown>): Promise<unknown> {
    return this.client.getResponse(responseId, params)
  }

  async listInputItems(responseId: string, params: Record<string, unknown>): Promise<unknown> {
    return this.client.getResponseInputItems(responseId, params)
  }

  async createInputTokens(responseId: string, payload: unknown): Promise<unknown> {
    return this.client.createResponseInputTokens(responseId, payload)
  }

  async delete(responseId: string): Promise<unknown> {
    return this.client.deleteResponse(responseId)
  }
}

export function createResourceDispatcher(): ResourceDispatcher {
  return configStore.isEmulatorEnabled()
    ? new EmulatorResourceDispatcher()
    : new UpstreamResourceDispatcher()
}
```

- [ ] **Step 2: Run validation**

```bash
bun run lint:all && bun run typecheck && bun run build && bun test
```

- [ ] **Step 3: Commit**

```bash
git add src/dispatch/resource-dispatcher.ts
git commit -m "refactor: create ResourceDispatcher to eliminate emulator branching"
```

---

## Phase 6: Translate Layer

### Task 11: Create Translate Infrastructure

Create the translator trait, registry, and shared utilities.

**Files:**
- Create: `src/translate/traits.ts`
- Create: `src/translate/registry.ts`
- Create: `src/translate/shared/block-handlers.ts`
- Create: `src/translate/shared/stop-reason.ts`
- Create: `src/translate/shared/thinking-budget.ts`
- Create: `src/translate/shared/tool-choice.ts`
- Create: `src/translate/shared/usage.ts`
- Create: `src/translate/index.ts`

- [ ] **Step 1: Create `src/translate/traits.ts`**

```typescript
import type { SSEOutput } from '~/lib/execution-strategy'
import type { TranslationPolicy } from '~/translator/anthropic/translation-policy'

export interface ProtocolTranslator<TSource = unknown, TTarget = unknown, TSourceChunk = unknown, TTargetChunk = unknown> {
  translateRequest(source: TSource, policy?: TranslationPolicy): TTarget
  translateResponse(result: unknown): unknown
  createStreamTranslator(): StreamTranslator<TSourceChunk, TTargetChunk>
}

export interface StreamTranslator<TSourceChunk = unknown, TTargetChunk = unknown> {
  onChunk(chunk: TSourceChunk): TTargetChunk | TTargetChunk[] | null
  onDone(): TTargetChunk | TTargetChunk[] | null
  onError?(error: unknown): TTargetChunk | TTargetChunk[] | null
}
```

- [ ] **Step 2: Create `src/translate/registry.ts`**

```typescript
import type { ProtocolTranslator } from './traits'

export type TranslatorKey = string

export class TranslatorRegistry {
  private translators = new Map<TranslatorKey, ProtocolTranslator>()

  register(key: TranslatorKey, translator: ProtocolTranslator): void {
    this.translators.set(key, translator)
  }

  get<T extends ProtocolTranslator = ProtocolTranslator>(key: TranslatorKey): T {
    const translator = this.translators.get(key)
    if (!translator) {
      throw new Error(`No translator registered for: ${key}`)
    }
    return translator as T
  }

  has(key: TranslatorKey): boolean {
    return this.translators.has(key)
  }
}

export const translatorRegistry = new TranslatorRegistry()
```

- [ ] **Step 3: Create `src/translate/shared/block-handlers.ts`**

```typescript
export type BlockHandlerMap<TBlock, TOutput> = Record<string, (block: TBlock) => TOutput | null>

export function dispatchBlock<TBlock extends { type: string }, TOutput>(
  block: TBlock,
  handlers: BlockHandlerMap<TBlock, TOutput>,
  fallback?: (block: TBlock) => TOutput | null,
): TOutput | null {
  const handler = handlers[block.type]
  if (handler) return handler(block)
  return fallback?.(block) ?? null
}

export function dispatchBlocks<TBlock extends { type: string }, TOutput>(
  blocks: TBlock[],
  handlers: BlockHandlerMap<TBlock, TOutput>,
  fallback?: (block: TBlock) => TOutput | null,
): TOutput[] {
  const results: TOutput[] = []
  for (const block of blocks) {
    const result = dispatchBlock(block, handlers, fallback)
    if (result !== null) results.push(result)
  }
  return results
}
```

- [ ] **Step 4: Create shared mapping tables**

`src/translate/shared/stop-reason.ts`:

```typescript
export const OPENAI_TO_ANTHROPIC_STOP_REASON: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'refusal',
}

export function mapStopReason(openaiReason: string | null | undefined): string | null {
  if (!openaiReason) return null
  return OPENAI_TO_ANTHROPIC_STOP_REASON[openaiReason] ?? openaiReason
}
```

`src/translate/shared/thinking-budget.ts`:

```typescript
export const REASONING_EFFORT_THRESHOLDS = {
  low: 8000,
  medium: 24000,
} as const

export const ADAPTIVE_DEFAULT_TOKENS = 24000

export function tokensToEffort(tokens: number): 'low' | 'medium' | 'high' {
  if (tokens <= REASONING_EFFORT_THRESHOLDS.low) return 'low'
  if (tokens <= REASONING_EFFORT_THRESHOLDS.medium) return 'medium'
  return 'high'
}

export function effortToTokens(effort: string): number {
  switch (effort) {
    case 'low': return REASONING_EFFORT_THRESHOLDS.low
    case 'medium': return REASONING_EFFORT_THRESHOLDS.medium
    default: return ADAPTIVE_DEFAULT_TOKENS
  }
}
```

`src/translate/shared/tool-choice.ts`:

```typescript
export const ANTHROPIC_TO_OPENAI_TOOL_CHOICE: Record<string, string> = {
  auto: 'auto',
  any: 'required',
  none: 'none',
}
```

`src/translate/shared/usage.ts`:

```typescript
export { mapOpenAIUsageToAnthropic } from '~/translator/anthropic/shared'
```

- [ ] **Step 5: Create `src/translate/shared/index.ts`**

```typescript
export { dispatchBlock, dispatchBlocks } from './block-handlers'
export type { BlockHandlerMap } from './block-handlers'
export { mapStopReason, OPENAI_TO_ANTHROPIC_STOP_REASON } from './stop-reason'
export { tokensToEffort, effortToTokens, REASONING_EFFORT_THRESHOLDS, ADAPTIVE_DEFAULT_TOKENS } from './thinking-budget'
export { ANTHROPIC_TO_OPENAI_TOOL_CHOICE } from './tool-choice'
export { mapOpenAIUsageToAnthropic } from './usage'
```

- [ ] **Step 6: Create `src/translate/index.ts`**

```typescript
export { translatorRegistry } from './registry'
export type { TranslatorKey } from './registry'
export type { ProtocolTranslator, StreamTranslator } from './traits'
export * from './shared/index'
```

- [ ] **Step 7: Run validation**

```bash
bun run lint:all && bun run typecheck && bun run build && bun test
```

- [ ] **Step 8: Commit**

```bash
git add src/translate/
git commit -m "refactor: create translate layer with registry, traits, and shared utilities"
```

---

## Phase 7: Guard Layer + Route Simplification

### Task 12: Create Guard Layer

Extract auth and rate-limit guard into standalone stage.

**Files:**
- Create: `src/guard/auth.ts`
- Create: `src/guard/index.ts`

- [ ] **Step 1: Create `src/guard/auth.ts`**

```typescript
import type { RawRequest } from '~/pipeline/types'

import { rateLimiter, authStore } from '~/state'
import { approval } from '~/lib/approval'

export async function runGuard(raw: RawRequest): Promise<void> {
  await rateLimiter.acquire(authStore.rateLimitSeconds, authStore.rateLimitWait)
  if (authStore.manualApprove) {
    await approval()
  }
}
```

- [ ] **Step 2: Create `src/guard/index.ts`**

```typescript
export { runGuard } from './auth'
```

- [ ] **Step 3: Run validation**

```bash
bun run lint:all && bun run typecheck && bun run build && bun test
```

- [ ] **Step 4: Commit**

```bash
git add src/guard/
git commit -m "refactor: create guard layer for auth and rate limiting"
```

---

### Task 13: Simplify messages route as pipeline composer

Rewrite the messages route as a thin pipeline composition using all new layers. This is the most complex route and serves as the template for all others.

**Files:**
- Modify: `src/routes/messages/route.ts`
- Modify: `src/routes/messages/handler.ts`

- [ ] **Step 1: Refactor `src/routes/messages/handler.ts` to use new layers**

Replace the inline model pipeline with the composable transform chain. Replace strategy context creation with `createStrategyContext()`. Replace the inline `try-catch` for `TranslationFailure` with `withTranslationErrors()`. Replace `findModelById()` with `resolveModelOrThrow()`.

Key changes in `handleMessagesCore()`:
- Replace lines 78-100 (inline model pipeline) with: `const modelResult = messagesModelChain.apply({ model: payload.model, payload, meta, headers })`
- Replace lines 120-122 (client/signal init) with: `const ctx = createStrategyContext({ payload, modelInfo: modelResult, meta, signal, headers })`
- Wrap the strategy execution with `executeWithContextRetry()`

- [ ] **Step 2: Run validation**

```bash
bun run lint:all && bun run typecheck && bun run build && bun test
```

- [ ] **Step 3: Commit**

```bash
git add src/routes/messages/
git commit -m "refactor: simplify messages route using pipeline layers"
```

---

### Task 14: Simplify remaining routes

Apply the same pipeline composition pattern to chat-completions, responses, and embeddings routes.

**Files:**
- Modify: `src/routes/chat-completions/handler.ts`
- Modify: `src/routes/responses/handler.ts`
- Modify: `src/routes/responses/resource-handler.ts`

- [ ] **Step 1: Refactor chat-completions handler**

Replace inline `applyModelRewrite()` + step tracking with `chatCompletionsModelChain.apply()`. Replace `createCopilotClient()` + `createUpstreamSignalFromConfig()` with `createStrategyContext()`.

- [ ] **Step 2: Refactor responses handler**

Replace inline `applyModelRewrite()` with `responsesModelChain.apply()`. Replace `shouldUseResponsesOfficialEmulator()` with `configStore.isEmulatorEnabled()`. Replace client/signal init with `createStrategyContext()`.

- [ ] **Step 3: Refactor resource-handler to use ResourceDispatcher**

Replace 4x `shouldUseResponsesOfficialEmulator()` if-else branches with:

```typescript
const dispatcher = createResourceDispatcher()
// Then use: dispatcher.retrieve(), dispatcher.listInputItems(), etc.
```

- [ ] **Step 4: Replace scattered error handling**

In `count-tokens-handler.ts` and `strategy-registry.ts`, replace `TranslationFailure` try-catch blocks with `withTranslationErrors()`. Replace `!selectedModel` checks with `resolveModelOrThrow()`.

- [ ] **Step 5: Run validation**

```bash
bun run lint:all && bun run typecheck && bun run build && bun test
```

- [ ] **Step 6: Commit**

```bash
git add src/routes/
git commit -m "refactor: simplify all routes using pipeline layers"
```

---

## Phase 8: Cleanup

### Task 15: Move remaining lib modules to stage directories

Move files from `src/lib/` to their destination stage directories. Create re-export shims in old locations for any external consumers (tests, scripts).

**Files:**
- Move: `src/lib/model-rewrite.ts` → `src/transform/rewrite-rules.ts` (keep as dependency)
- Move: `src/lib/request-model-policy.ts` → `src/transform/policy-rules.ts` (keep as dependency)
- Move: `src/lib/execution-strategy.ts` → `src/dispatch/execution-strategy.ts`
- Move: `src/lib/sse-adapter.ts` → `src/deliver/sse-adapter.ts`
- Move: `src/lib/upstream-signal.ts` → `src/infra/upstream-signal.ts`
- Move: `src/lib/upstream-request-queue.ts` → `src/infra/upstream-queue.ts`
- Move: `src/lib/retry.ts` → `src/infra/retry.ts`
- Move: `src/lib/request-logger.ts` → `src/infra/logger.ts`
- Move: `src/lib/tokenizer.ts` → `src/infra/tokenizer.ts`
- Move: `src/lib/error.ts` → `src/infra/error.ts`
- Move: `src/clients/` → `src/infra/` (or keep as-is)

- [ ] **Step 1: Move files using git mv**

For each file, use `git mv` and update imports. Work through one group at a time:

```bash
# Group 1: Transform dependencies
git mv src/lib/model-rewrite.ts src/transform/rewrite-rules.ts
git mv src/lib/request-model-policy.ts src/transform/policy-rules.ts
git mv src/lib/model-resolver.ts src/transform/resolver.ts
git mv src/lib/model-capabilities.ts src/transform/capabilities.ts
```

Create re-export shims at old locations:

```typescript
// src/lib/model-rewrite.ts (shim)
export * from '~/transform/rewrite-rules'
```

- [ ] **Step 2: Update imports for moved files**

Search and replace all imports referencing old paths:

```bash
rg "from '~/lib/model-rewrite'" src/ tests/ --files-with-matches
# Update each file to import from new location
```

- [ ] **Step 3: Move infrastructure files**

```bash
mkdir -p src/infra
git mv src/lib/upstream-signal.ts src/infra/upstream-signal.ts
git mv src/lib/upstream-request-queue.ts src/infra/upstream-queue.ts
git mv src/lib/retry.ts src/infra/retry.ts
git mv src/lib/request-logger.ts src/infra/logger.ts
git mv src/lib/error.ts src/infra/error.ts
```

Create re-export shims at old locations.

- [ ] **Step 4: Run validation**

```bash
bun run lint:all && bun run typecheck && bun run build && bun test
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move lib modules to stage-based directories"
```

---

### Task 16: Remove old shims and empty directories

Remove backward-compat re-export shims from `src/lib/` once all consumers are migrated. Delete empty directories.

- [ ] **Step 1: Verify no direct consumers remain**

```bash
rg "from '~/lib/state'" src/ --files-with-matches
rg "from '~/lib/config'" src/ --files-with-matches
rg "from '~/lib/model-capabilities'" src/ --files-with-matches
rg "from '~/lib/rate-limit'" src/ --files-with-matches
rg "from '~/lib/model-rewrite'" src/ --files-with-matches
rg "from '~/lib/request-model-policy'" src/ --files-with-matches
```

If any remain, update them to use new paths.

- [ ] **Step 2: Remove shim files**

Delete each shim file that only re-exports from the new location. Keep `src/lib/` files that haven't been moved (validation/, shell.ts, paths.ts, version.ts, etc.).

- [ ] **Step 3: Remove empty old directories**

```bash
# Only if completely empty:
rmdir src/routes/messages/strategies 2>/dev/null || true
rmdir src/routes/middleware 2>/dev/null || true
```

- [ ] **Step 4: Update `src/server.ts` imports if needed**

Ensure server.ts still compiles with new route structure.

- [ ] **Step 5: Run full validation**

```bash
bun run lint:all && bun run typecheck && bun run build && bun test
```

- [ ] **Step 6: Final smoke test**

```bash
bun run smoke:packaged
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: remove backward-compat shims and clean up directories"
```

---

### Task 17: Update design documentation

Update `docs/design/` to reflect the new architecture.

- [ ] **Step 1: Update `docs/design/module-structure.md`**

Replace the directory tree with the new pipeline-stage-based structure.

- [ ] **Step 2: Update `docs/design/architecture-overview.md`**

Add sections for pipeline stages, protocol registry, and state stores.

- [ ] **Step 3: Update `CLAUDE.md`**

Update the Architecture section and Key Modules table to reflect the new directory structure.

- [ ] **Step 4: Commit**

```bash
git add docs/ CLAUDE.md
git commit -m "docs: update architecture documentation for pipeline redesign"
```

---

## Summary

| Phase | Tasks | Description |
|-------|-------|-------------|
| 1 | 1-4 | State decomposition (5 stores) |
| 2 | 5-6 | Pipeline framework + deliver layer |
| 3 | 7 | Protocol registry (ingest layer) |
| 4 | 8 | Composable model transform chain |
| 5 | 9-10 | Strategy registry + ResourceDispatcher |
| 6 | 11 | Translate layer (registry, traits, shared) |
| 7 | 12-14 | Guard layer + route simplification |
| 8 | 15-17 | File moves, shim removal, doc updates |

**Total: 17 tasks across 8 phases**

Each phase ends with `bun run lint:all && bun run typecheck && bun run build && bun test` passing. External contracts (API endpoints, CLI arguments, config.json schema) are unchanged throughout.
