# Pipeline Migration Completion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the 5-layer pipeline migration (Guard → Ingest → Transform → Dispatch → Deliver) by fixing all remaining gaps identified in the design spec.

**Architecture:** Three categories of work: (1) Guard layer — add `requestGuardPlugin` to `/embeddings` and `{ guarded: true }` to `/responses` resource routes, (2) Ingest layer — replace one bypass where `responses/input_tokens` calls `parseResponsesInputTokensPayload()` directly instead of going through `protocolRegistry.ingest()`, (3) Dispatch layer — make the generic `StrategyRegistry` class generic with `execute()` pattern, migrate messages to use it, create single-entry registries for chat-completions and responses.

**Tech Stack:** TypeScript, Elysia, Bun test runner

**Spec:** `docs/superpowers/specs/2026-04-21-pipeline-migration-design.md`

**Validation command:** `bun run lint:all && bun run typecheck && bun run build && bun test`

---

### Task 1: Guard — add `requestGuardPlugin` to `/embeddings`

**Files:**
- Modify: `src/routes/embeddings/route.ts`

- [ ] **Step 1: Add guard plugin to embeddings route**

```typescript
import { Elysia } from 'elysia'

import { requestGuardPlugin } from '~/routes/middleware/request-guard'

import { handleEmbeddingsCore } from './handler'

export function createEmbeddingRoutes() {
  return new Elysia()
    .use(requestGuardPlugin)
    .post('/embeddings', async ({ body }) => {
      return handleEmbeddingsCore(body)
    }, { guarded: true })
}
```

- [ ] **Step 2: Run validation**

Run: `bun run lint:all && bun run typecheck && bun run build && bun test`
Expected: All pass — guard is a no-op when `rateLimitSeconds` is undefined and `manualApprove` is false (the test defaults).

- [ ] **Step 3: Commit**

```bash
git add src/routes/embeddings/route.ts
git commit -m "fix: add request guard to /embeddings route"
```

---

### Task 2: Guard — add `{ guarded: true }` to `/responses` resource routes

**Files:**
- Modify: `src/routes/responses/route.ts`

- [ ] **Step 1: Add `{ guarded: true }` to GET/DELETE endpoints**

The plugin is already registered via `.use(requestGuardPlugin)` at the top.
Add `{ guarded: true }` as the options argument to the three unguarded endpoints:

In `src/routes/responses/route.ts`, change the three resource endpoints:

```typescript
    .get('/responses/:responseId/input_items', async ({ params, request }) => {
      return handleListResponseInputItemsCore({
        params,
        url: request.url,
        headers: request.headers,
        signal: request.signal,
      })
    }, { guarded: true })
    .get('/responses/:responseId', async ({ params, request, server }) => {
      if (hasStreamingResponsesQuery(request)) {
        disableIdleTimeout(server, request)
      }

      return handleRetrieveResponseCore({
        params,
        url: request.url,
        headers: request.headers,
        signal: request.signal,
      })
    }, { guarded: true })
    .delete('/responses/:responseId', async ({ params, request }) => {
      return handleDeleteResponseCore({
        params,
        headers: request.headers,
        signal: request.signal,
      })
    }, { guarded: true })
```

- [ ] **Step 2: Run validation**

Run: `bun run lint:all && bun run typecheck && bun run build && bun test`
Expected: All pass.

- [ ] **Step 3: Commit**

```bash
git add src/routes/responses/route.ts
git commit -m "fix: add request guard to /responses resource routes"
```

---

### Task 3: Ingest — fix `responses/input_tokens` bypass

**Files:**
- Modify: `src/routes/responses/resource-handler.ts`

- [ ] **Step 1: Replace direct parse call with `protocolRegistry.ingest()`**

In `src/routes/responses/resource-handler.ts`, update the imports. Remove `normalizeResponsesRequestContext` and `parseResponsesInputTokensPayload`, add `protocolRegistry`:

Old imports:
```typescript
import { normalizeResponsesRequestContext, readCapiRequestContext } from '~/core/capi/request-context'
import { createResourceDispatcher } from '~/dispatch/resource-dispatcher'
import { throwInvalidRequestError } from '~/lib/error'
import { parseResponsesInputTokensPayload } from '~/lib/validation'
```

New imports:
```typescript
import { readCapiRequestContext } from '~/core/capi/request-context'
import { createResourceDispatcher } from '~/dispatch/resource-dispatcher'
import { protocolRegistry } from '~/ingest'
import { throwInvalidRequestError } from '~/lib/error'
```

Then update `handleCreateResponseInputTokensCore`:

Old:
```typescript
export async function handleCreateResponseInputTokensCore(
  { body, headers, signal }: ResourceHandlerBodyParams,
): Promise<object> {
  const payload = parseResponsesInputTokensPayload(body)
  const requestContext = normalizeResponsesRequestContext(payload, headers)
  const dispatcher = createResourceDispatcher()
  return await dispatcher.createInputTokens(
    payload,
    { requestContext, signal },
  ) as object
}
```

New:
```typescript
export async function handleCreateResponseInputTokensCore(
  { body, headers, signal }: ResourceHandlerBodyParams,
): Promise<object> {
  const { payload, meta } = protocolRegistry.ingest<import('~/types').ResponsesInputTokensPayload>(
    'responses-input-tokens',
    body,
    headers,
  )
  const dispatcher = createResourceDispatcher()
  return await dispatcher.createInputTokens(
    payload,
    { requestContext: meta.requestContext, signal },
  ) as object
}
```

- [ ] **Step 2: Run validation**

Run: `bun run lint:all && bun run typecheck && bun run build && bun test`
Expected: All pass. The `responsesInputTokensProtocol` handler calls the same `parseResponsesInputTokensPayload` and `normalizeResponsesRequestContext` internally, so behavior is identical.

- [ ] **Step 3: Commit**

```bash
git add src/routes/responses/resource-handler.ts
git commit -m "refactor: route responses/input_tokens through protocolRegistry.ingest()"
```

---

### Task 4: Dispatch — make generic `StrategyRegistry` use `execute()` pattern

**Files:**
- Modify: `src/dispatch/strategy-registry.ts`
- Modify: `src/dispatch/index.ts`

- [ ] **Step 1: Update `StrategyEntry` interface and `StrategyRegistry` class**

Replace the entire content of `src/dispatch/strategy-registry.ts`:

```typescript
import type { ExecutionResult } from '~/lib/execution-strategy'
import type { Model } from '~/types'

import consola from 'consola'

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

- [ ] **Step 2: Update dispatch barrel export**

`src/dispatch/index.ts` — no changes needed, re-exports already cover `StrategyRegistry` and `StrategyEntry`.

- [ ] **Step 3: Run validation**

Run: `bun run typecheck`
Expected: Pass — `StrategyRegistry` is not imported by any production code yet (verified via grep: no consumer imports it from `~/dispatch`).

- [ ] **Step 4: Commit**

```bash
git add src/dispatch/strategy-registry.ts
git commit -m "refactor: make StrategyRegistry generic with execute() pattern"
```

---

### Task 5: Dispatch — migrate messages to generic `StrategyRegistry`

**Files:**
- Modify: `src/routes/messages/strategy-registry.ts`
- Modify: `src/routes/messages/handler.ts`

- [ ] **Step 1: Refactor messages strategy-registry to use generic `StrategyRegistry`**

In `src/routes/messages/strategy-registry.ts`:

1. Remove local `StrategyEntry` interface, `StrategyResult` interface, and `selectStrategy()` function
2. Import `StrategyRegistry` from `~/dispatch`
3. Change each entry's `execute()` to return `ExecutionResult` directly (drop `modelMapping` wrapping)
4. Export `StrategyContext` type (still needed by handler) and a `StrategyRegistry` instance

Replace the interfaces and select function (lines 24-58) with:

```typescript
import { StrategyRegistry } from '~/dispatch'
```

Remove these local definitions:
- `interface StrategyResult` (lines 35-38)
- `interface StrategyEntry` (lines 40-44) 
- `function selectStrategy()` (lines 46-58)

Keep `interface StrategyContext` (lines 24-33) — this is the context type for the generic `StrategyRegistry`.

Update each of the 3 strategy entries to return `ExecutionResult` instead of `StrategyResult`:

**nativeMessagesEntry** (around line 184):
```typescript
const nativeMessagesEntry: StrategyEntry<StrategyContext> = {
  name: 'native-messages',
  canHandle: model => modelCache.supportsEndpoint(model, MESSAGES_ENDPOINT),
  async execute(ctx) {
    filterThinkingBlocksForNativeMessages(ctx.anthropicPayload)
    sanitizeOutputConfig(ctx.anthropicPayload, ctx.selectedModel)
    sanitizeCacheControl(ctx.anthropicPayload)

    const strategy = createNativeMessagesStrategy(
      ctx.copilotClient,
      ctx.anthropicPayload,
      ctx.anthropicBetaHeader,
      {
        signal: ctx.upstreamSignal.signal,
        requestContext: ctx.requestContext,
      },
    )
    return await runStrategy(strategy, ctx.upstreamSignal)
  },
}
```

**responsesApiEntry** (around line 206):
```typescript
const responsesApiEntry: StrategyEntry<StrategyContext> = {
  name: 'responses-api',
  canHandle: model => modelCache.supportsEndpoint(model, RESPONSES_ENDPOINT),
  async execute(ctx) {
    const responsesPayload = withTranslationErrors(() =>
      translateAnthropicToResponsesPayload(ctx.anthropicPayload, {
        reasoningEffortResolver: model => configStore.getReasoningEffort(model),
      }),
    )

    applyContextManagement(
      responsesPayload,
      ctx.selectedModel?.capabilities.limits.max_prompt_tokens,
    )
    compactInputByLatestCompaction(responsesPayload)

    const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
    const strategy = createMessagesViaResponsesStrategy(
      ctx.copilotClient,
      responsesPayload,
      {
        vision,
        initiator,
        signal: ctx.upstreamSignal.signal,
        requestContext: ctx.requestContext,
      },
    )
    return await runStrategy(strategy, ctx.upstreamSignal)
  },
}
```

**chatCompletionsEntry** (around line 238):
```typescript
const chatCompletionsEntry: StrategyEntry<StrategyContext> = {
  name: 'chat-completions',
  canHandle: () => true,
  async execute(ctx) {
    const adapter = createAnthropicAdapter()
    const plan = withTranslationErrors(() =>
      adapter.toCapiPlan(ctx.anthropicPayload, {
        requestContext: ctx.requestContext,
      }),
    )

    appendModelStep(ctx.modelMapping, 'MODEL_RESOLVE', plan.resolvedModel)

    consola.debug(
      'Claude Code requested model:',
      ctx.anthropicPayload.model,
      '-> Copilot model:',
      plan.resolvedModel,
    )
    if (consola.level >= 4) {
      consola.debug(
        'Planned Copilot request payload:',
        JSON.stringify(plan.payload),
      )
    }

    const transport = new CopilotTransport(ctx.copilotClient)
    const strategy = createMessagesViaChatCompletionsStrategy(
      transport,
      adapter,
      plan,
      ctx.upstreamSignal.signal,
    )
    return await runStrategy(strategy, ctx.upstreamSignal)
  },
}
```

Replace the export at the bottom (line 276-280):

```typescript
export const defaultStrategyRegistry = new StrategyRegistry<StrategyContext>()
defaultStrategyRegistry.register(nativeMessagesEntry)
defaultStrategyRegistry.register(responsesApiEntry)
defaultStrategyRegistry.register(chatCompletionsEntry)
```

Remove unused imports: `ModelMappingInfo` type import is still needed by `StrategyContext`. Check if `StrategyResult` was used anywhere — it was only in the local interface, so removing it is safe.

Add `StrategyEntry` import from dispatch. The full import block at the top becomes:

```typescript
import type { StrategyEntry } from '~/dispatch'
import type { CopilotClient } from '~/clients'
import type { CapiRequestContext } from '~/core/capi'
import type { ModelMappingInfo } from '~/lib/request-logger'
import type { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'
import type { AnthropicMessagesPayload } from '~/translator'
import type { Model } from '~/types'

import consola from 'consola'
import { CopilotTransport } from '~/adapters'
import { StrategyRegistry } from '~/dispatch'
import { withTranslationErrors } from '~/lib/error'
import { runStrategy } from '~/lib/execution-strategy'
import { appendModelStep } from '~/lib/request-logger'
import { configStore, MESSAGES_ENDPOINT, modelCache, RESPONSES_ENDPOINT } from '~/state'
import { translateAnthropicToResponsesPayload } from '~/translator/responses/anthropic-to-responses'
import { SignatureCodec } from '~/translator/responses/signature-codec'

import { applyContextManagement, compactInputByLatestCompaction, getResponsesRequestOptions } from '../responses/context-management'
import { createAnthropicAdapter } from './shared'
import { createMessagesViaChatCompletionsStrategy } from './strategies/chat-completions'
import { createNativeMessagesStrategy } from './strategies/native-messages'
import { createMessagesViaResponsesStrategy } from './strategies/responses-api'
```

Note: Remove `import type { ExecutionResult } from '~/lib/execution-strategy'` — no longer needed since `execute()` returns `ExecutionResult` which is inferred from `StrategyEntry<StrategyContext>`.

- [ ] **Step 2: Update messages handler to use `StrategyRegistry.select()`**

In `src/routes/messages/handler.ts`, change import:

Old:
```typescript
import { defaultStrategyRegistry, selectStrategy } from './strategy-registry'
```

New:
```typescript
import { defaultStrategyRegistry } from './strategy-registry'
```

Then in `handleMessagesCore()` (around line 88), change:

Old:
```typescript
const currentEntry = selectStrategy(defaultStrategyRegistry, currentModel)
```

New:
```typescript
const currentEntry = defaultStrategyRegistry.select(currentModel)
```

The rest of the handler stays the same. The `executeWithContextRetry` wrapper and the `currentEntry.execute(ctx)` call pattern remain unchanged because the entry's `execute()` still takes `StrategyContext` and now returns `ExecutionResult` directly.

Update the result handling (around line 90-101):

Old:
```typescript
      const sr = await currentEntry.execute({
        copilotClient,
        anthropicPayload: currentPayload,
        anthropicBetaHeader,
        selectedModel: currentModel,
        upstreamSignal: currentSignal,
        headers,
        requestContext,
        modelMapping,
      })
      return sr.result
```

New:
```typescript
      return await currentEntry.execute({
        copilotClient,
        anthropicPayload: currentPayload,
        anthropicBetaHeader,
        selectedModel: currentModel,
        upstreamSignal: currentSignal,
        headers,
        requestContext,
        modelMapping,
      })
```

- [ ] **Step 3: Run validation**

Run: `bun run lint:all && bun run typecheck && bun run build && bun test`
Expected: All pass — behavior is identical, only the selection mechanism changed.

- [ ] **Step 4: Commit**

```bash
git add src/routes/messages/strategy-registry.ts src/routes/messages/handler.ts
git commit -m "refactor: migrate messages to generic StrategyRegistry"
```

---

### Task 6: Dispatch — create chat-completions StrategyRegistry

**Files:**
- Create: `src/routes/chat-completions/strategy-registry.ts`
- Modify: `src/routes/chat-completions/handler.ts`

- [ ] **Step 1: Create `src/routes/chat-completions/strategy-registry.ts`**

```typescript
import type { StrategyEntry } from '~/dispatch'
import type { CopilotClient } from '~/clients'
import type { CapiRequestContext } from '~/core/capi'
import type { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'
import type { ChatCompletionsPayload } from '~/types'

import { CopilotTransport, OpenAIChatAdapter } from '~/adapters'
import { StrategyRegistry } from '~/dispatch'
import { runStrategy } from '~/lib/execution-strategy'
import { appendModelStep, type ModelMappingInfo, type ModelTransformTag } from '~/lib/request-logger'
import consola from 'consola'

import { createChatCompletionsStrategy } from './strategy'

export interface ChatCompletionsStrategyContext {
  copilotClient: CopilotClient
  payload: ChatCompletionsPayload
  upstreamSignal: ReturnType<typeof createUpstreamSignalFromConfig>
  requestContext: Partial<CapiRequestContext>
  modelMapping: ModelMappingInfo
}

const chatCompletionsEntry: StrategyEntry<ChatCompletionsStrategyContext> = {
  name: 'chat-completions-passthrough',
  canHandle: () => true,
  async execute(ctx) {
    const adapter = new OpenAIChatAdapter()
    const plan = adapter.toCapiPlan(ctx.payload, {
      requestContext: ctx.requestContext,
    })

    appendModelStep(ctx.modelMapping, 'MODEL_RESOLVE', plan.resolvedModel)

    consola.debug(
      'Chat completions model:',
      ctx.payload.model,
      '-> Copilot model:',
      plan.resolvedModel,
    )
    if (consola.level >= 4) {
      consola.debug(
        'Planned Copilot request payload:',
        JSON.stringify(plan.payload),
      )
    }

    const transport = new CopilotTransport(ctx.copilotClient)
    const strategy = createChatCompletionsStrategy(transport, adapter, plan, ctx.upstreamSignal.signal)
    return await runStrategy(strategy, ctx.upstreamSignal)
  },
}

export const chatCompletionsStrategyRegistry = new StrategyRegistry<ChatCompletionsStrategyContext>()
chatCompletionsStrategyRegistry.register(chatCompletionsEntry)
```

- [ ] **Step 2: Update `src/routes/chat-completions/handler.ts`**

Replace with a simplified handler that delegates to the registry:

```typescript
import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ModelMappingInfo, ModelTransformTag } from '~/lib/request-logger'
import type { ChatCompletionsPayload } from '~/types'

import consola from 'consola'
import { protocolRegistry } from '~/ingest'
import { createCopilotClient } from '~/lib/state'
import { getTokenCount } from '~/lib/tokenizer'
import { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'
import { modelCache } from '~/state'
import { chatCompletionsModelChain } from '~/transform'

import { chatCompletionsStrategyRegistry } from './strategy-registry'

export interface CompletionCoreParams {
  body: unknown
  signal: AbortSignal
  headers: Headers
}

export interface CompletionCoreResult {
  result: ExecutionResult
  modelMapping?: ModelMappingInfo
}

export async function handleCompletionCore(
  { body, signal, headers }: CompletionCoreParams,
): Promise<CompletionCoreResult> {
  const { payload: parsedPayload, meta } = protocolRegistry.ingest<ChatCompletionsPayload>(
    'openai-chat',
    body,
    headers,
  )
  let payload = parsedPayload
  const requestContext = meta.requestContext as Partial<import('~/core/capi').CapiRequestContext>
  consola.debug('Request payload:', JSON.stringify(payload).slice(-400))

  const transformResult = chatCompletionsModelChain.apply({ model: payload.model, payload, headers })
  payload.model = transformResult.model

  const selectedModel = modelCache.findById(payload.model)

  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      consola.info('Current token count:', tokenCount)
    }
    else {
      consola.warn('No model selected, skipping token count calculation')
    }
  }
  catch (error) {
    consola.warn('Failed to calculate token count:', error)
  }

  if (payload.max_tokens == null) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    consola.debug('Set max_tokens to:', JSON.stringify(payload.max_tokens))
  }

  const upstreamSignal = createUpstreamSignalFromConfig(signal)
  const copilotClient = createCopilotClient()

  const originalModel = transformResult.trace.length > 0 ? transformResult.trace[0].from : payload.model
  const modelMapping: ModelMappingInfo = {
    originalModel,
    steps: transformResult.trace.map(r => ({ tag: r.tag as ModelTransformTag, from: r.from, to: r.to })),
  }

  const entry = chatCompletionsStrategyRegistry.select(selectedModel)
  consola.debug('Streaming response')
  const result = await entry.execute({
    copilotClient,
    payload,
    upstreamSignal,
    requestContext,
    modelMapping,
  })

  return { result, modelMapping }
}
```

- [ ] **Step 3: Run validation**

Run: `bun run lint:all && bun run typecheck && bun run build && bun test`
Expected: All pass. The strategy now runs through the registry but the execution path is identical.

- [ ] **Step 4: Commit**

```bash
git add src/routes/chat-completions/strategy-registry.ts src/routes/chat-completions/handler.ts
git commit -m "refactor: create chat-completions StrategyRegistry"
```

---

### Task 7: Dispatch — create responses StrategyRegistry

**Files:**
- Create: `src/routes/responses/strategy-registry.ts`
- Modify: `src/routes/responses/handler.ts`

- [ ] **Step 1: Create `src/routes/responses/strategy-registry.ts`**

```typescript
import type { StrategyEntry } from '~/dispatch'
import type { CopilotClient } from '~/clients'
import type { CapiRequestContext } from '~/core/capi'
import type { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'
import type { ResponsesPayload, ResponsesResult } from '~/types'

import { StrategyRegistry } from '~/dispatch'
import { resolveInitiator } from '~/core/capi/request-context'
import { runStrategy } from '~/lib/execution-strategy'

import { createResponsesPassthroughStrategy } from './strategy'

export interface ResponsesStrategyContext {
  copilotClient: CopilotClient
  payload: ResponsesPayload
  upstreamSignal: ReturnType<typeof createUpstreamSignalFromConfig>
  requestContext: Partial<CapiRequestContext>
  vision: boolean
  initiator: string
  decorateResponse?: (response: ResponsesResult) => ResponsesResult
  onTerminalResponse?: (response: ResponsesResult) => void
}

const responsesPassthroughEntry: StrategyEntry<ResponsesStrategyContext> = {
  name: 'responses-passthrough',
  canHandle: () => true,
  async execute(ctx) {
    const strategy = createResponsesPassthroughStrategy(ctx.copilotClient, ctx.payload, {
      vision: ctx.vision,
      initiator: resolveInitiator(ctx.initiator, ctx.requestContext),
      requestContext: ctx.requestContext,
      signal: ctx.upstreamSignal.signal,
      mapResponse: ctx.decorateResponse,
      onTerminalResponse: ctx.onTerminalResponse,
    })
    return await runStrategy(strategy, ctx.upstreamSignal)
  },
}

export const responsesStrategyRegistry = new StrategyRegistry<ResponsesStrategyContext>()
responsesStrategyRegistry.register(responsesPassthroughEntry)
```

- [ ] **Step 2: Update `src/routes/responses/handler.ts`**

Replace with a handler that uses the registry. The core logic (tool transforms, input policies, emulator prep, context management) stays in the handler — only strategy creation/execution moves to the registry.

```typescript
import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ModelMappingInfo, ModelTransformTag } from '~/lib/request-logger'
import type { ResponsesPayload, ResponsesResult, ResponseFunctionTool, ResponseTool } from '~/types'

import consola from 'consola'
import { protocolRegistry } from '~/ingest'
import { throwInvalidRequestError } from '~/lib/error'
import { normalizeFunctionParametersSchemaForCopilot } from '~/lib/function-schema'
import { createCopilotClient } from '~/lib/state'
import { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'
import { configStore, modelCache, RESPONSES_ENDPOINT } from '~/state'
import { responsesModelChain } from '~/transform'

import { applyContextManagement, compactInputByLatestCompaction, getResponsesRequestOptions } from './context-management'
import { decorateStoredResponse, persistEmulatorResponse, prepareEmulatorRequest } from './emulator'
import { responsesStrategyRegistry } from './strategy-registry'

const HTTP_URL_RE = /^https?:\/\//i

export interface ResponsesCoreParams {
  body: unknown
  signal: AbortSignal
  headers: Headers
}

export interface ResponsesCoreResult {
  result: ExecutionResult
  modelMapping?: ModelMappingInfo
}

export async function handleResponsesCore(
  { body, signal, headers }: ResponsesCoreParams,
): Promise<ResponsesCoreResult> {
  const { payload, meta } = protocolRegistry.ingest<ResponsesPayload>(
    'responses',
    body,
    headers,
  )
  const requestContext = meta.requestContext as Partial<import('~/core/capi').CapiRequestContext>
  const emulatorMode = configStore.isEmulatorEnabled()
  const emulatorPrepared = emulatorMode
    ? prepareEmulatorRequest(payload)
    : undefined

  const effectivePayload = emulatorPrepared?.upstreamPayload ?? payload

  const transformResult = responsesModelChain.apply({ model: effectivePayload.model, payload: effectivePayload, headers })
  effectivePayload.model = transformResult.model

  applyResponsesToolTransforms(effectivePayload)
  applyResponsesInputPolicies(effectivePayload)
  compactInputByLatestCompaction(effectivePayload)

  const selectedModel = modelCache.findById(effectivePayload.model)
  if (!selectedModel) {
    throwInvalidRequestError(
      'The selected model could not be resolved.',
      'model',
    )
  }
  if (!modelCache.supportsEndpoint(selectedModel, RESPONSES_ENDPOINT)) {
    throwInvalidRequestError(
      'The selected model does not support the responses endpoint.',
      'model',
    )
  }

  applyContextManagement(
    effectivePayload,
    selectedModel.capabilities.limits.max_prompt_tokens,
  )

  const { vision, initiator } = getResponsesRequestOptions(effectivePayload)
  const upstreamSignal = createUpstreamSignalFromConfig(signal)
  const copilotClient = createCopilotClient()
  const decorateResponse = emulatorPrepared
    ? (response: ResponsesResult) => decorateStoredResponse(response, payload, emulatorPrepared)
    : undefined

  const entry = responsesStrategyRegistry.select(selectedModel)
  const result = await entry.execute({
    copilotClient,
    payload: effectivePayload,
    upstreamSignal,
    requestContext,
    vision,
    initiator,
    decorateResponse,
    onTerminalResponse: emulatorPrepared
      ? (terminalResponse) => {
          if (!emulatorPrepared?.shouldStore) {
            return
          }
          persistEmulatorResponse(
            terminalResponse,
            emulatorPrepared.effectiveInputItems,
          )
        }
      : undefined,
  })

  if (
    emulatorPrepared
    && result.kind === 'json'
  ) {
    const emulatedResponse = decorateStoredResponse(
      result.data as ResponsesResult,
      payload,
      emulatorPrepared,
    )
    if (emulatorPrepared.shouldStore) {
      persistEmulatorResponse(emulatedResponse, emulatorPrepared.effectiveInputItems)
    }
    result.data = emulatedResponse
  }

  const originalModel = transformResult.trace.length > 0 ? transformResult.trace[0].from : effectivePayload.model
  const modelMapping: ModelMappingInfo = {
    originalModel,
    steps: transformResult.trace.map(r => ({ tag: r.tag as ModelTransformTag, from: r.from, to: r.to })),
  }

  return { result, modelMapping }
}

function applyResponsesToolTransforms(payload: ResponsesPayload): void {
  applyFunctionApplyPatch(payload)
  applyFunctionToolCompatibilityDefaults(payload)
  rejectUnsupportedBuiltinTools(payload)
}

function applyFunctionToolCompatibilityDefaults(payload: ResponsesPayload): void {
  if (!Array.isArray(payload.tools)) {
    return
  }

  payload.tools = payload.tools.map((tool) => {
    if (!isResponseFunctionTool(tool)) {
      return tool
    }

    return {
      ...tool,
      parameters: normalizeFunctionParametersSchemaForCopilot(tool.parameters),
      strict: tool.strict ?? true,
    }
  })
}

function isResponseFunctionTool(tool: ResponseTool): tool is ResponseFunctionTool {
  return tool.type === 'function'
}

function applyFunctionApplyPatch(payload: ResponsesPayload): void {
  if (!configStore.isFunctionApplyPatchEnabled() || !Array.isArray(payload.tools)) {
    return
  }

  payload.tools = payload.tools.map((tool) => {
    if (
      tool.type === 'custom'
      && typeof tool.name === 'string'
      && tool.name === 'apply_patch'
    ) {
      return {
        type: 'function',
        name: tool.name,
        description: 'Use the `apply_patch` tool to edit files',
        parameters: {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description: 'The entire contents of the apply_patch command',
            },
          },
          required: ['input'],
        },
        strict: false,
      }
    }

    return tool
  })
}

function rejectUnsupportedBuiltinTools(payload: ResponsesPayload): void {
  if (
    payload.tool_choice
    && typeof payload.tool_choice === 'object'
    && 'type' in payload.tool_choice
    && (payload.tool_choice.type === 'web_search_preview'
      || payload.tool_choice.type === 'web_search_preview_2025_03_11')
  ) {
    throwInvalidRequestError(
      'The selected Copilot endpoint does not support the Responses web_search tool.',
      'tool_choice',
      'unsupported_tool_web_search',
    )
  }

  if (!Array.isArray(payload.tools)) {
    return
  }

  for (const tool of payload.tools) {
    if (tool.type === 'web_search') {
      throwInvalidRequestError(
        'The selected Copilot endpoint does not support the Responses web_search tool.',
        'tools',
        'unsupported_tool_web_search',
      )
    }
  }
}

function applyResponsesInputPolicies(payload: ResponsesPayload): void {
  payload.store = false

  stripUnresolvableInputItems(payload)
  stripPhaseFromInputMessages(payload)
  rejectUnsupportedRemoteImageUrls(payload)
}

function stripPhaseFromInputMessages(payload: ResponsesPayload): void {
  if (!Array.isArray(payload.input)) {
    return
  }

  let stripped = 0
  for (const item of payload.input) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const rec = item as Record<string, unknown>
    const isMessage = !('type' in rec) || rec.type === 'message'
    if (isMessage && 'phase' in rec) {
      delete rec.phase
      stripped++
    }
  }

  if (stripped > 0) {
    consola.debug(`Stripped phase from ${stripped} input message item(s)`)
  }
}

function stripUnresolvableInputItems(payload: ResponsesPayload): void {
  if (!Array.isArray(payload.input)) {
    return
  }

  const functionCallIds = new Set<string>()
  for (const item of payload.input) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const rec = item as Record<string, unknown>
    if (rec.type === 'function_call' && typeof rec.call_id === 'string') {
      functionCallIds.add(rec.call_id)
    }
  }

  const originalLength = payload.input.length
  payload.input = payload.input.filter((item) => {
    if (typeof item !== 'object' || item === null) {
      return true
    }

    const rec = item as Record<string, unknown>

    if (rec.type === 'item_reference') {
      return false
    }

    if (
      rec.type === 'function_call_output'
      && typeof rec.call_id === 'string'
      && !functionCallIds.has(rec.call_id)
    ) {
      return false
    }

    return true
  })

  if (payload.input.length !== originalLength) {
    consola.debug(
      `Stripped ${originalLength - payload.input.length} unresolvable input items`
      + ` (item_reference / orphaned function_call_output)`,
    )
  }
}

function rejectUnsupportedRemoteImageUrls(payload: ResponsesPayload): void {
  if (!Array.isArray(payload.input) || !containsRemoteImageUrl(payload.input)) {
    return
  }

  throwInvalidRequestError(
    'The selected Copilot endpoint does not support external image URLs on the Responses API. Use file_id or data URL image input instead.',
    'input',
    'unsupported_input_image_remote_url',
  )
}

function containsRemoteImageUrl(value: unknown): boolean {
  if (!value) {
    return false
  }
  if (Array.isArray(value)) {
    return value.some(entry => containsRemoteImageUrl(entry))
  }
  if (typeof value !== 'object') {
    return false
  }

  const record = value as Record<string, unknown>
  if (
    record.type === 'input_image'
    && typeof record.image_url === 'string'
    && HTTP_URL_RE.test(record.image_url)
  ) {
    return true
  }

  return Object.values(record).some(entry => containsRemoteImageUrl(entry))
}
```

- [ ] **Step 3: Run validation**

Run: `bun run lint:all && bun run typecheck && bun run build && bun test`
Expected: All pass. Strategy execution is identical, only routed through the registry.

- [ ] **Step 4: Commit**

```bash
git add src/routes/responses/strategy-registry.ts src/routes/responses/handler.ts
git commit -m "refactor: create responses StrategyRegistry"
```

---

### Task 8: Cleanup and documentation update

**Files:**
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/specs/2026-04-21-pipeline-migration-design.md`

- [ ] **Step 1: Update migration design spec status**

In `docs/superpowers/specs/2026-04-21-pipeline-migration-design.md`, change the status line:

Old:
```
**Status:** In Progress (Phases 1/3/4 complete, Phases 2/5 remaining)
```

New:
```
**Status:** Implemented
```

Also update Phase 2, Phase 3, and Phase 5 headers to show ✅ COMPLETE.

- [ ] **Step 2: Update CLAUDE.md architecture section**

In `CLAUDE.md`, replace the "Model Pipeline" section (the "### Model Pipeline (`/v1/messages`)" heading and content about "4-stage model transformation") with pipeline-stage documentation that reflects the 5-layer architecture. Also update the Key Modules table to include all current directories.

Replace lines 51-67 (the "### Model Pipeline" section and "### Three Execution Paths" section) to reflect the pipeline stages. The key changes:

- Replace "4-stage model transformation" wording with "5-layer request pipeline"
- Document: Guard → Ingest → Transform → Dispatch → Deliver
- Keep the three execution paths description (it's still accurate for the messages route)
- Update Key Modules table to include `src/guard/`, `src/ingest/`, `src/transform/`, `src/dispatch/`, `src/deliver/` with current descriptions

- [ ] **Step 3: Update AGENTS.md to match CLAUDE.md**

Mirror the same architecture description changes in `AGENTS.md`.

- [ ] **Step 4: Check for dead dispatch code**

Run: `grep -r "dispatch/strategy-runner" src/` — if any imports reference a deleted strategy-runner, remove them.
Run: `grep -r "from '~/lib/execution-strategy'" src/routes/` — verify strategies still import `runStrategy` from the right place (they should, as we kept these imports).

- [ ] **Step 5: Run full validation**

Run: `bun run lint:all && bun run typecheck && bun run build && bun test`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md AGENTS.md docs/superpowers/specs/2026-04-21-pipeline-migration-design.md
git commit -m "docs: update architecture docs to reflect completed 5-layer pipeline"
```

---

### Task 9: Final validation

- [ ] **Step 1: Run full CI pipeline locally**

Run: `bun run lint:all && bun run typecheck && bun run build && bun test`
Expected: All pass.

- [ ] **Step 2: Verify no dual implementations remain**

Run these checks:
```bash
# No direct parse function imports in route handlers (should go through protocolRegistry)
grep -r "parseResponsesInputTokensPayload\|parseAnthropicMessagesPayload\|parseOpenAIChatPayload\|parseResponsesPayload\|parseEmbeddingRequest" src/routes/

# No local selectStrategy function remaining
grep -r "function selectStrategy" src/routes/

# All routes have guard (except models/token/usage)
grep -rn "guarded:" src/routes/
```

Expected:
- No direct parse imports in `src/routes/` (only in `src/ingest/` and `src/lib/validation.ts`)
- No `selectStrategy` function in `src/routes/`
- `guarded: true` in messages, chat-completions, embeddings, and all responses endpoints

- [ ] **Step 3: Confirm architecture compliance**

Check each route handler follows the 5-layer pattern:
- Guard: `requestGuardPlugin` + `{ guarded: true }` ✓
- Ingest: `protocolRegistry.ingest()` ✓
- Transform: `*ModelChain.apply()` ✓
- Dispatch: `*StrategyRegistry.select()` + `entry.execute()` ✓
- Deliver: `deliverResult()` or plain object return ✓
