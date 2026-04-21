# Pipeline Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire all pipeline layers (transform, ingest, dispatch, guard, deliver) into production route handlers, eliminating dual implementations and establishing a 5-stage pipeline: Guard → Ingest → Transform → Dispatch → Deliver.

**Architecture:** Incremental migration across 5 phases. Each phase produces a working, tested codebase. Transform chains replace inline model pipelines; ingest registry replaces inline parsing; dispatch consolidates strategy selection and error recovery; deliver extracts response formatting from route files; guard unifies rate limiting.

**Tech Stack:** TypeScript, Elysia, Bun test runner

**Spec:** `docs/superpowers/specs/2026-04-21-pipeline-migration-design.md`

---

## Phase 1: Transform Chain Integration

### Task 1: Unify trace format — ModelTransformStep

The transform chain produces `ModelTransformRecord` (`{tag, from, to}`) but `request-logger.ts` uses `ModelTransformStep` (`{tag, result}`). Unify to a single format.

**Files:**
- Modify: `src/lib/request-logger.ts`
- Modify: `src/routes/messages/strategy-registry.ts` (consumers of `appendModelStep`)
- Modify: `src/pipeline/types.ts` (source of truth for the new type)

- [ ] **Step 1: Update ModelTransformStep in request-logger.ts**

In `src/lib/request-logger.ts`, replace the `ModelTransformStep` interface and update all functions that reference `result`:

```typescript
export interface ModelTransformStep {
  tag: ModelTransformTag
  from: string
  to: string
}
```

- [ ] **Step 2: Update getEffectiveModel to use `to` instead of `result`**

In `src/lib/request-logger.ts`, update `getEffectiveModel`:

```typescript
export function getEffectiveModel(info: ModelMappingInfo): string {
  return info.steps.length > 0
    ? info.steps.at(-1)!.to
    : info.originalModel ?? '-'
}
```

- [ ] **Step 3: Update appendModelStep to use `from`/`to`**

In `src/lib/request-logger.ts`, update `appendModelStep`:

```typescript
export function appendModelStep(
  info: ModelMappingInfo,
  tag: ModelTransformTag,
  newModel: string,
): ModelMappingInfo {
  const current = getEffectiveModel(info)
  if (newModel === current)
    return info
  return {
    originalModel: info.originalModel,
    steps: [...info.steps, { tag, from: current, to: newModel }],
  }
}
```

- [ ] **Step 4: Update formatModelMapping to use `to`**

In `src/lib/request-logger.ts`, in `formatModelMapping`, update the step rendering loop:

```typescript
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const isLast = i === steps.length - 1
    parts.push(colorize('dim', `-[${step.tag}]->`))
    parts.push(colorize(isLast ? 'greenBright' : 'cyanBright', step.to))
  }
```

- [ ] **Step 5: Update inline step creation in messages handler**

In `src/routes/messages/handler.ts`, update step creation to use `from`/`to` format. Find the `handleMessagesCore` function and update each `steps.push(...)`:

```typescript
  // Stage 1 (around line 80):
  if (rewrite.reason) {
    steps.push({ tag: rewrite.reason, from: rewrite.originalModel, to: rewrite.model })
  }

  // Stage 2 (around line 92):
  if (betaResult.upgradeTarget) {
    steps.push({ tag: 'BETA_UPGRADE', from: anthropicPayload.model, to: betaResult.upgradeTarget })
    ...
  }

  // Stage 3 (around line 101-104):
  if (modelRouting.reason === 'context-upgrade') {
    steps.push({ tag: 'CONTEXT_UPGRADE', from: modelRouting.originalModel, to: modelRouting.routedModel })
  }
  else if (modelRouting.reason === 'compact') {
    steps.push({ tag: 'COMPACT', from: modelRouting.originalModel, to: modelRouting.routedModel })
  }
```

- [ ] **Step 6: Update inline step creation in chat-completions handler**

In `src/routes/chat-completions/handler.ts`, update step creation (around line 43-44):

```typescript
  if (rewrite.reason) {
    steps.push({ tag: rewrite.reason, from: rewrite.originalModel, to: rewrite.model })
  }
```

- [ ] **Step 7: Update inline step creation in messages strategy-registry context retry**

In `src/routes/messages/handler.ts`, find the retry block (around line 162) and update:

```typescript
    modelMapping: {
      originalModel: rewrite.originalModel,
      steps: [...steps, { tag: 'RETRY_UPGRADE', from: anthropicPayload.model, to: upgradeTarget }],
    },
```

- [ ] **Step 8: Run tests and typecheck**

Run: `bun test && bun run typecheck`
Expected: ALL PASS (trace format is internal, no behavioral change)

- [ ] **Step 9: Commit**

```bash
git add src/lib/request-logger.ts src/routes/messages/handler.ts src/routes/chat-completions/handler.ts
git commit -m "refactor: unify ModelTransformStep to {tag, from, to} trace format"
```

---

### Task 2: Move processAnthropicBetaHeader to transform layer

Currently `processAnthropicBetaHeader` is defined in `routes/messages/handler.ts` and imported by `transform/beta-headers.ts` — a backwards dependency. Move it to the transform layer.

**Files:**
- Modify: `src/transform/beta-headers.ts` — move function here
- Modify: `src/routes/messages/handler.ts` — import from transform instead of defining locally

- [ ] **Step 1: Move processAnthropicBetaHeader into transform/beta-headers.ts**

In `src/transform/beta-headers.ts`, replace the entire file with:

```typescript
import type { ModelTransformStep } from './types'

import { getContextUpgradeTarget } from '~/lib/model-rewrite'
import { configStore } from '~/state'

const CONTEXT_BETA_RE = /^context-\d+[km]-/

export interface BetaHeaderResult {
  header: string | undefined
  upgradeTarget: string | undefined
}

export function processAnthropicBetaHeader(
  rawHeader: string | null,
  model: string,
): BetaHeaderResult {
  if (!rawHeader)
    return { header: undefined, upgradeTarget: undefined }

  const values = rawHeader.split(',').map(v => v.trim()).filter(Boolean)
  let upgradeTarget: string | undefined
  const filtered: string[] = []

  for (const value of values) {
    if (CONTEXT_BETA_RE.test(value)) {
      if (!upgradeTarget && configStore.isContextUpgradeEnabled()) {
        const target = getContextUpgradeTarget(model)
        if (target) {
          upgradeTarget = target
        }
      }
      continue
    }
    filtered.push(value)
  }

  return {
    header: filtered.length > 0 ? filtered.join(',') : undefined,
    upgradeTarget,
  }
}

export const betaHeaderStep: ModelTransformStep = {
  tag: 'BETA_UPGRADE',
  apply({ model, headers }) {
    if (!headers)
      return null
    const betaHeader = headers.get('anthropic-beta')
    const result = processAnthropicBetaHeader(betaHeader, model)
    if (!result.upgradeTarget)
      return null
    return {
      model: result.upgradeTarget,
      mutatePayload(payload: unknown) {
        if (payload && typeof payload === 'object' && 'model' in payload)
          (payload as Record<string, unknown>).model = result.upgradeTarget
      },
    }
  },
}
```

- [ ] **Step 2: Update messages handler to import from transform**

In `src/routes/messages/handler.ts`, remove the local `processAnthropicBetaHeader` function definition (lines 27-63) and the `CONTEXT_BETA_RE` constant (line 27). Add import:

```typescript
import { processAnthropicBetaHeader } from '~/transform/beta-headers'
```

Remove the local `BetaHeaderResult` interface as well. Remove the now-unused imports `getContextUpgradeTarget` from `~/lib/model-rewrite` (keep `applyModelRewrite` and `isContextLengthError`).

- [ ] **Step 3: Update transform/index.ts exports**

In `src/transform/index.ts`, add the export for `processAnthropicBetaHeader` and `BetaHeaderResult`:

```typescript
export { betaHeaderStep, processAnthropicBetaHeader } from './beta-headers'
export type { BetaHeaderResult } from './beta-headers'
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test && bun run typecheck`
Expected: ALL PASS (pure code move, no behavioral change)

- [ ] **Step 5: Commit**

```bash
git add src/transform/beta-headers.ts src/transform/index.ts src/routes/messages/handler.ts
git commit -m "refactor: move processAnthropicBetaHeader to transform layer"
```

---

### Task 3: Wire messagesModelChain into messages handler

Replace the inline 3-step model transform pipeline with `messagesModelChain.apply()`.

**Files:**
- Modify: `src/routes/messages/handler.ts`
- Modify: `src/transform/chain.ts` (minor: expose filtered beta header via meta)

- [ ] **Step 1: Refactor messages handler to use the transform chain**

In `src/routes/messages/handler.ts`, replace the `handleMessagesCore` function. The key change: replace the 3 inline stages (rewrite + beta + policy) with a single chain call.

The full updated function:

```typescript
export async function handleMessagesCore(
  { body, signal, headers }: MessagesCoreParams,
): Promise<MessagesCoreResult> {
  const anthropicPayload = parseAnthropicMessagesPayload(body)
  const requestContext = normalizeAnthropicRequestContext(anthropicPayload, headers)
  if (consola.level >= 4)
    consola.debug('Anthropic request payload:', JSON.stringify(anthropicPayload))

  // Parse beta headers for both the transform chain and strategy context
  const betaResult = processAnthropicBetaHeader(
    headers.get('anthropic-beta'),
    anthropicPayload.model,
  )
  const anthropicBetaHeader = betaResult.header

  // Run the 3-step model transform chain (rewrite → beta upgrade → policy)
  const rawBeta = headers.get('anthropic-beta')
  const betaHeaders = rawBeta ? rawBeta.split(',').map(v => v.trim()).filter(Boolean) : undefined
  const transformResult = messagesModelChain.apply({
    model: anthropicPayload.model,
    payload: anthropicPayload,
    headers,
    meta: { betaHeaders },
  })

  // Apply the final model from the chain
  anthropicPayload.model = transformResult.model
  const selectedModel = transformResult.resolvedModel

  // Convert chain trace to ModelMappingInfo
  const originalModel = transformResult.trace.length > 0
    ? transformResult.trace[0].from
    : anthropicPayload.model
  const modelMapping: ModelMappingInfo = {
    originalModel,
    steps: transformResult.trace.map(r => ({
      tag: r.tag as ModelTransformTag,
      from: r.from,
      to: r.to,
    })),
  }

  if (transformResult.trace.length > 0) {
    consola.debug(
      `Model transform chain:`,
      transformResult.trace.map(r => `${r.from}-[${r.tag}]->${r.to}`).join(', '),
    )
  }

  const upstreamSignal = createUpstreamSignalFromConfig(signal)
  const copilotClient = createCopilotClient()

  const entry = selectStrategy(defaultStrategyRegistry, selectedModel)

  const strategyCtx = {
    copilotClient,
    anthropicPayload,
    anthropicBetaHeader,
    selectedModel,
    upstreamSignal,
    headers,
    requestContext,
    modelMapping,
  }

  let strategyResult
  try {
    strategyResult = await entry.execute(strategyCtx)
  }
  catch (error) {
    const upgradeTarget = configStore.isContextUpgradeEnabled() && isContextLengthError(error)
      ? getContextUpgradeTarget(anthropicPayload.model)
      : undefined

    if (!upgradeTarget)
      throw error

    consola.info(
      `Context length exceeded, retrying: ${anthropicPayload.model} → ${upgradeTarget}`,
    )
    anthropicPayload.model = upgradeTarget
    const retryModel = modelCache.findById(upgradeTarget)
    const retrySignal = createUpstreamSignalFromConfig(signal)
    const retryEntry = selectStrategy(defaultStrategyRegistry, retryModel)
    strategyResult = await retryEntry.execute({
      ...strategyCtx,
      anthropicPayload,
      selectedModel: retryModel,
      upstreamSignal: retrySignal,
      modelMapping: {
        originalModel,
        steps: [...modelMapping.steps, { tag: 'RETRY_UPGRADE' as ModelTransformTag, from: anthropicPayload.model, to: upgradeTarget }],
      },
    })
  }

  return {
    result: strategyResult.result,
    modelMapping: strategyResult.modelMapping,
  }
}
```

- [ ] **Step 2: Update imports in messages handler**

At the top of `src/routes/messages/handler.ts`, update imports:

```typescript
import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ModelMappingInfo, ModelTransformTag } from '~/lib/request-logger'
import consola from 'consola'

import { normalizeAnthropicRequestContext } from '~/core/capi/request-context'
import { getContextUpgradeTarget, isContextLengthError } from '~/lib/model-rewrite'
import { createCopilotClient } from '~/lib/state'
import { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'
import { parseAnthropicMessagesPayload } from '~/lib/validation'
import { configStore, modelCache } from '~/state'
import { messagesModelChain } from '~/transform'
import { processAnthropicBetaHeader } from '~/transform/beta-headers'

import { defaultStrategyRegistry, selectStrategy } from './strategy-registry'
```

Remove the import of `applyModelRewrite` and `applyMessagesModelPolicy` — they're now called by the chain internally.

- [ ] **Step 3: Run tests and typecheck**

Run: `bun test && bun run typecheck`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/routes/messages/handler.ts
git commit -m "refactor: wire messagesModelChain into messages handler"
```

---

### Task 4: Wire transform chains into chat-completions and responses handlers

**Files:**
- Modify: `src/routes/chat-completions/handler.ts`
- Modify: `src/routes/responses/handler.ts`

- [ ] **Step 1: Update chat-completions handler**

In `src/routes/chat-completions/handler.ts`, replace the inline rewrite with the chain. Replace lines 40-45:

```typescript
  // Model rewrite (normalize + user rules)
  const rewrite = applyModelRewrite(payload)
  const steps: ModelTransformStep[] = []
  if (rewrite.reason) {
    steps.push({ tag: rewrite.reason, result: rewrite.model })
  }
```

With:

```typescript
  // Model rewrite via transform chain
  const transformResult = chatCompletionsModelChain.apply({
    model: payload.model,
    payload,
    headers,
  })
  payload.model = transformResult.model
```

Update the `modelMapping` construction (around line 76-80):

```typescript
  const originalModel = transformResult.trace.length > 0
    ? transformResult.trace[0].from
    : payload.model

  const modelMapping = appendModelStep(
    {
      originalModel,
      steps: transformResult.trace.map(r => ({
        tag: r.tag as ModelTransformTag,
        from: r.from,
        to: r.to,
      })),
    },
    'MODEL_RESOLVE',
    plan.resolvedModel,
  )
```

Update imports: remove `applyModelRewrite`, add `chatCompletionsModelChain` from `~/transform`. Remove unused `ModelTransformStep` import type. Add `ModelTransformTag` import type.

- [ ] **Step 2: Update responses handler**

In `src/routes/responses/handler.ts`, replace the inline rewrite (around line 47):

```typescript
  const rewrite = applyModelRewrite(emulatorPrepared?.upstreamPayload ?? payload)
```

With:

```typescript
  const effectivePayload = emulatorPrepared?.upstreamPayload ?? payload
  const transformResult = responsesModelChain.apply({
    model: effectivePayload.model,
    payload: effectivePayload,
    headers,
  })
  effectivePayload.model = transformResult.model
```

Remove the old `const effectivePayload = emulatorPrepared?.upstreamPayload ?? payload` line (now moved above).

Update the `modelMapping` at the end (around line 117-119):

```typescript
  const originalModel = transformResult.trace.length > 0
    ? transformResult.trace[0].from
    : effectivePayload.model
  const modelMapping: ModelMappingInfo = {
    originalModel,
    steps: transformResult.trace.map(r => ({
      tag: r.tag as ModelTransformTag,
      from: r.from,
      to: r.to,
    })),
  }
```

Update imports: remove `applyModelRewrite`, add `responsesModelChain` from `~/transform`. Add `ModelTransformTag` import type.

- [ ] **Step 3: Run tests and typecheck**

Run: `bun test && bun run typecheck`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/routes/chat-completions/handler.ts src/routes/responses/handler.ts
git commit -m "refactor: wire transform chains into chat-completions and responses handlers"
```

---

## Phase 2: Dispatch Consolidation

### Task 5: Wire executeWithContextRetry into messages handler

Replace the inline context-length error retry with `dispatch/error-recovery.ts`.

**Files:**
- Modify: `src/routes/messages/handler.ts`
- Modify: `src/dispatch/error-recovery.ts` (update to match handler's needs)

- [ ] **Step 1: Update executeWithContextRetry to accept configStore check**

In `src/dispatch/error-recovery.ts`, the current function doesn't check `configStore.isContextUpgradeEnabled()`. Update it:

```typescript
import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ModelTransformResult } from '~/pipeline/types'

import consola from 'consola'
import { getContextUpgradeTarget, isContextLengthError } from '~/lib/model-rewrite'
import { configStore } from '~/state'

export async function executeWithContextRetry(
  executeFn: (model: string) => Promise<ExecutionResult>,
  modelInfo: ModelTransformResult,
): Promise<ExecutionResult> {
  try {
    return await executeFn(modelInfo.model)
  }
  catch (error) {
    if (!isContextLengthError(error))
      throw error
    if (!configStore.isContextUpgradeEnabled())
      throw error
    const upgradeTarget = getContextUpgradeTarget(modelInfo.model)
    if (!upgradeTarget)
      throw error
    consola.info(`Context length error → retrying with ${upgradeTarget}`)
    return await executeFn(upgradeTarget)
  }
}
```

- [ ] **Step 2: Update messages handler to use executeWithContextRetry**

In `src/routes/messages/handler.ts`, replace the try/catch block (the strategy execution section) with:

```typescript
  const executeStrategy = async (model: string): Promise<StrategyResult> => {
    if (model !== anthropicPayload.model) {
      anthropicPayload.model = model
    }
    const currentModel = modelCache.findById(model)
    const currentEntry = selectStrategy(defaultStrategyRegistry, currentModel)
    const currentSignal = model === transformResult.model
      ? upstreamSignal
      : createUpstreamSignalFromConfig(signal)
    return currentEntry.execute({
      ...strategyCtx,
      anthropicPayload,
      selectedModel: currentModel,
      upstreamSignal: currentSignal,
    })
  }

  const strategyResult = await executeWithContextRetry(
    async (model) => {
      const sr = await executeStrategy(model)
      return sr.result
    },
    transformResult,
  )
```

Note: this loses the per-retry modelMapping update. Since the retry upgrade is tracked by `executeWithContextRetry` internally and the handler already constructed `modelMapping` from the chain, the retry model change is visible in the final model. If you need the RETRY_UPGRADE step in the mapping, add it back via a post-execution check comparing the final model vs the chain's model.

Add import:

```typescript
import { executeWithContextRetry } from '~/dispatch/error-recovery'
```

Remove the now-unused `isContextLengthError` and `getContextUpgradeTarget` imports from `~/lib/model-rewrite`.

- [ ] **Step 3: Run tests and typecheck**

Run: `bun test && bun run typecheck`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/dispatch/error-recovery.ts src/routes/messages/handler.ts
git commit -m "refactor: wire executeWithContextRetry into messages handler"
```

---

### Task 6: Clean up dispatch re-exports and consolidate selectStrategy

**Files:**
- Delete: `src/dispatch/strategy-runner.ts`
- Modify: `src/dispatch/index.ts`
- Modify: `src/dispatch/strategy-registry.ts`

- [ ] **Step 1: Delete strategy-runner.ts**

Delete `src/dispatch/strategy-runner.ts` — it's a pure re-export of `~/lib/execution-strategy`.

- [ ] **Step 2: Update dispatch/index.ts**

Remove the strategy-runner re-exports. Keep only what's actually used:

```typescript
export { executeWithContextRetry } from './error-recovery'
export { createResourceDispatcher } from './resource-dispatcher'
export type { ResourceDispatcher, ResourceRequestOptions } from './resource-dispatcher'
export { StrategyRegistry } from './strategy-registry'
export type { StrategyEntry } from './strategy-registry'
```

- [ ] **Step 3: Verify no imports of dispatch/strategy-runner remain**

Run: `grep -r "dispatch/strategy-runner\|~/dispatch.*strategy-runner\|~/dispatch.*runStrategy\|~/dispatch.*passthroughSSE\|~/dispatch.*ExecutionResult\|~/dispatch.*ExecutionStrategy\|~/dispatch.*SSEOutput\|~/dispatch.*SSEStreamChunk" src/`

Expected: No matches. All consumers should import from `~/lib/execution-strategy` directly.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test && bun run typecheck`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove dispatch/strategy-runner re-exports"
```

---

## Phase 3: Ingest Integration

### Task 7: Wire protocolRegistry into all handlers

Replace inline `parse*()` + `normalize*RequestContext()` calls with `protocolRegistry.ingest()`.

**Files:**
- Modify: `src/routes/messages/handler.ts`
- Modify: `src/routes/messages/count-tokens-handler.ts`
- Modify: `src/routes/chat-completions/handler.ts`
- Modify: `src/routes/responses/handler.ts`
- Modify: `src/routes/embeddings/handler.ts`

- [ ] **Step 1: Wire ingest into messages handler**

In `src/routes/messages/handler.ts`, replace:

```typescript
  const anthropicPayload = parseAnthropicMessagesPayload(body)
  const requestContext = normalizeAnthropicRequestContext(anthropicPayload, headers)
```

With:

```typescript
  const { payload: anthropicPayload, meta } = protocolRegistry.ingest<AnthropicMessagesPayload>(
    'anthropic-messages',
    body,
    headers,
  )
  const requestContext = meta.requestContext as Partial<CapiRequestContext>
```

Also update the beta headers extraction to use `meta.betaHeaders` instead of re-parsing:

```typescript
  const betaResult = processAnthropicBetaHeader(
    headers.get('anthropic-beta'),
    anthropicPayload.model,
  )
  const anthropicBetaHeader = betaResult.header

  const transformResult = messagesModelChain.apply({
    model: anthropicPayload.model,
    payload: anthropicPayload,
    headers,
    meta: { betaHeaders: meta.betaHeaders },
  })
```

Add import:

```typescript
import { protocolRegistry } from '~/ingest'
```

Remove imports: `parseAnthropicMessagesPayload` from `~/lib/validation`, `normalizeAnthropicRequestContext` from `~/core/capi/request-context`.

- [ ] **Step 2: Wire ingest into count-tokens handler**

In `src/routes/messages/count-tokens-handler.ts`, replace:

```typescript
  const anthropicPayload = parseAnthropicCountTokensPayload(body)
  normalizeAnthropicRequestContext(anthropicPayload, headers)
```

With:

```typescript
  const { payload: anthropicPayload } = protocolRegistry.ingest<AnthropicCountTokensPayload>(
    'anthropic-count-tokens',
    body,
    headers,
  )
```

Add import: `import { protocolRegistry } from '~/ingest'`
Add type import: `import type { AnthropicCountTokensPayload } from '~/translator'`
Remove: `parseAnthropicCountTokensPayload` from `~/lib/validation`, `normalizeAnthropicRequestContext` from `~/core/capi/request-context`.

- [ ] **Step 3: Wire ingest into chat-completions handler**

In `src/routes/chat-completions/handler.ts`, replace:

```typescript
  let payload = parseOpenAIChatPayload(body)
  const requestContext = normalizeChatRequestContext(payload, headers)
```

With:

```typescript
  const { payload: parsedPayload, meta } = protocolRegistry.ingest<ChatCompletionsPayload>(
    'openai-chat',
    body,
    headers,
  )
  let payload = parsedPayload
  const requestContext = meta.requestContext
```

Add import: `import { protocolRegistry } from '~/ingest'`
Add type import: `import type { ChatCompletionsPayload } from '~/types'`
Remove: `parseOpenAIChatPayload` from `~/lib/validation`, `normalizeChatRequestContext` from `~/core/capi/request-context`.

- [ ] **Step 4: Wire ingest into responses handler**

In `src/routes/responses/handler.ts`, replace:

```typescript
  const payload = parseResponsesPayload(body)
  const requestContext = normalizeResponsesRequestContext(payload, headers)
```

With:

```typescript
  const { payload, meta } = protocolRegistry.ingest<ResponsesPayload>(
    'responses',
    body,
    headers,
  )
  const requestContext = meta.requestContext
```

Add import: `import { protocolRegistry } from '~/ingest'`
Remove: `parseResponsesPayload` from `~/lib/validation`, `normalizeResponsesRequestContext` from `~/core/capi/request-context`.

- [ ] **Step 5: Wire ingest into embeddings handler**

In `src/routes/embeddings/handler.ts`, replace:

```typescript
  const payload = parseEmbeddingRequest(body)
```

With:

```typescript
  const { payload } = protocolRegistry.ingest<EmbeddingRequest>(
    'embeddings',
    body,
    headers,
  )
```

Update the function signature to accept `headers`:

```typescript
export async function handleEmbeddingsCore(body: unknown, headers: Headers): Promise<object> {
```

Add import: `import { protocolRegistry } from '~/ingest'`
Remove: `parseEmbeddingRequest` from `~/lib/validation`.

Check and update the caller in the embeddings route file to pass `headers`.

- [ ] **Step 6: Run tests and typecheck**

Run: `bun test && bun run typecheck`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/routes/ src/ingest/
git commit -m "refactor: wire protocolRegistry into all route handlers"
```

---

## Phase 4: Deliver Layer

### Task 8: Create deliver layer and wire into route files

Extract the duplicated JSON/SSE response dispatch from 3 route files.

**Files:**
- Create: `src/deliver/index.ts`
- Modify: `src/routes/messages/route.ts`
- Modify: `src/routes/responses/route.ts`
- Modify: `src/routes/chat-completions/route.ts`

- [ ] **Step 1: Create src/deliver/index.ts**

```typescript
import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ModelMappingInfo } from '~/lib/request-logger'

import { setRequestModelMapping } from '~/lib/request-logger'
import { sseAdapter } from '~/lib/sse-adapter'

export type DeliveryResult =
  | { streaming: false, data: unknown }
  | { streaming: true, stream: AsyncGenerator<unknown> }

export function deliverResult(
  request: Request,
  result: ExecutionResult,
  modelMapping?: ModelMappingInfo,
): DeliveryResult {
  if (modelMapping) {
    setRequestModelMapping(request, modelMapping)
  }
  if (result.kind === 'json') {
    return { streaming: false, data: result.data }
  }
  return { streaming: true, stream: sseAdapter(result.generator) }
}
```

Note: `deliverResult` is a regular function (not a generator) because `yield*` from a sub-generator does not propagate `return` values to the outer generator in JavaScript. Instead, it returns a discriminated union that the route handler dispatches with a simple `if`.

- [ ] **Step 2: Wire deliver into messages route**

In `src/routes/messages/route.ts`, replace the `/messages` handler body:

```typescript
import { deliverResult } from '~/deliver'
```

```typescript
    .post('/messages', async function* ({ body, request, server }) {
      if (hasStreamingFlag(body)) {
        disableIdleTimeout(server, request)
      }

      const { result, modelMapping } = await handleMessagesCore({
        body,
        signal: request.signal,
        headers: request.headers,
      })
      const delivery = deliverResult(request, result, modelMapping)
      if (!delivery.streaming) return delivery.data
      yield* delivery.stream
    }, { guarded: true })
```

Remove imports: `setRequestModelMapping` from `~/lib/request-logger`, `sseAdapter` from `~/lib/sse-adapter`.

- [ ] **Step 3: Wire deliver into chat-completions route**

In `src/routes/chat-completions/route.ts`, same pattern:

```typescript
import { deliverResult } from '~/deliver'
```

```typescript
    .post('/chat/completions', async function* ({ body, request, server }) {
      if (hasStreamingFlag(body)) {
        disableIdleTimeout(server, request)
      }

      const { result, modelMapping } = await handleCompletionCore({
        body,
        signal: request.signal,
        headers: request.headers,
      })
      const delivery = deliverResult(request, result, modelMapping)
      if (!delivery.streaming) return delivery.data
      yield* delivery.stream
    }, { guarded: true })
```

Remove imports: `setRequestModelMapping` from `~/lib/request-logger`, `sseAdapter` from `~/lib/sse-adapter`.

- [ ] **Step 4: Wire deliver into responses route**

In `src/routes/responses/route.ts`, update the POST `/responses` handler:

```typescript
import { deliverResult } from '~/deliver'
```

```typescript
    .post('/responses', async function* ({ body, request, server }) {
      disableIdleTimeout(server, request)

      const { result, modelMapping } = await handleResponsesCore({
        body,
        signal: request.signal,
        headers: request.headers,
      })
      const delivery = deliverResult(request, result, modelMapping)
      if (!delivery.streaming) return delivery.data
      yield* delivery.stream
    }, { guarded: true })
```

Remove imports: `setRequestModelMapping` from `~/lib/request-logger`, `sseAdapter` from `~/lib/sse-adapter`.

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test && bun run typecheck`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/deliver/ src/routes/
git commit -m "refactor: create deliver layer, wire into route files"
```

---

## Phase 5: Guard Consolidation + Cleanup

### Task 9: Consolidate guard with request-guard middleware

The guard layer (`src/guard/auth.ts`) and the Elysia middleware (`src/routes/middleware/request-guard.ts`) contain identical logic. Make guard/ the canonical source.

**Files:**
- Modify: `src/routes/middleware/request-guard.ts` — import from guard/
- Keep: `src/guard/auth.ts` as-is (already correct)

- [ ] **Step 1: Update request-guard middleware to use guard layer**

In `src/routes/middleware/request-guard.ts`:

```typescript
import { Elysia } from 'elysia'

import { runGuard } from '~/guard'

export const requestGuardPlugin = new Elysia({ name: 'request-guard' })
  .macro({
    guarded: (enabled: boolean) => ({
      async beforeHandle() {
        if (!enabled)
          return
        await runGuard()
      },
    }),
  })
```

Remove the local `runRequestGuard` function, `awaitApproval` import, and `authStore`/`rateLimiter` imports.

- [ ] **Step 2: Check for direct imports of runRequestGuard**

Run: `grep -r "runRequestGuard" src/ tests/`

If any consumers import `runRequestGuard`, update them to import `runGuard` from `~/guard` instead.

- [ ] **Step 3: Run tests and typecheck**

Run: `bun test && bun run typecheck`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/routes/middleware/request-guard.ts
git commit -m "refactor: consolidate guard - middleware delegates to guard layer"
```

---

### Task 10: Delete dead code and verify no dual implementations

**Files:**
- Delete: `src/pipeline/context.ts` (thin wrapper, unused)
- Modify: `src/pipeline/index.ts` (remove context export)
- Verify: no handler directly imports `applyModelRewrite`, `applyMessagesModelPolicy`, or parse functions

- [ ] **Step 1: Remove pipeline/context.ts**

Delete `src/pipeline/context.ts`.

Update `src/pipeline/index.ts`:

```typescript
export type { ModelTransformRecord, ModelTransformResult, RawRequest } from './types'
```

- [ ] **Step 2: Verify no direct imports of replaced functions**

Run these checks:

```bash
# Should return only transform/ layer internals, not route handlers:
grep -r "applyModelRewrite" src/ --include="*.ts" | grep -v "transform/" | grep -v "node_modules" | grep -v "lib/model-rewrite.ts"

# Should return nothing from handlers:
grep -r "applyMessagesModelPolicy" src/ --include="*.ts" | grep -v "transform/" | grep -v "node_modules" | grep -v "lib/request-model-policy.ts"

# Parse functions should only be in ingest/ and lib/validation:
grep -r "parseAnthropicMessagesPayload\|parseOpenAIChatPayload\|parseResponsesPayload\|parseEmbeddingRequest" src/ --include="*.ts" | grep -v "ingest/" | grep -v "node_modules" | grep -v "lib/validation"
```

If any handler still imports these directly, update it to use the pipeline layer instead.

- [ ] **Step 3: Run full CI pipeline**

Run: `bun run lint:all && bun run typecheck && bun run build && bun test`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove dead pipeline code, verify no dual implementations"
```

---

## Final Validation

### Task 11: End-to-end verification

- [ ] **Step 1: Run full CI pipeline**

Run: `bun run lint:all && bun run typecheck && bun run build && bun test`
Expected: ALL PASS

- [ ] **Step 2: Review the complete diff**

Run: `git diff main...HEAD --stat`
Verify: changes are limited to the expected files across all 5 phases.

- [ ] **Step 3: Review architecture alignment**

Verify the 5-stage pipeline is realized:
- **Guard**: `src/guard/` → used by `routes/middleware/request-guard.ts`
- **Ingest**: `src/ingest/` → used by all route handlers
- **Transform**: `src/transform/` → used by messages, chat-completions, responses handlers
- **Dispatch**: `src/dispatch/` → error-recovery used by messages, resource-dispatcher used by responses
- **Deliver**: `src/deliver/` → used by all streaming route files
