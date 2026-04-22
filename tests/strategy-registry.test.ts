import type { StateSnapshot } from './helpers'

import type { StrategyEntry } from '~/dispatch'
import type { ExecutionResult } from '~/lib/execution-strategy'
import type { Model } from '~/types'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { StrategyRegistry } from '~/dispatch'

import { modelCache } from '~/state'
import { buildModel, buildModelsResponse, restoreStateSnapshot, saveStateSnapshot } from './helpers'

// ── Helpers ──

function makeEntry<TCtx = unknown>(
  name: string,
  canHandle: (model: Model | undefined) => boolean,
): StrategyEntry<TCtx> {
  return {
    name,
    canHandle,
    execute: () => Promise.resolve({ kind: 'json', data: {} } as ExecutionResult),
  }
}

// ── StrategyRegistry (generic) ──

describe('StrategyRegistry', () => {
  test('throws on empty registry', () => {
    const registry = new StrategyRegistry()
    expect(() => registry.select(undefined)).toThrow('StrategyRegistry has no registered entries')
  })

  test('single entry with canHandle returning true', () => {
    const registry = new StrategyRegistry()
    const entry = makeEntry('only', () => true)
    registry.register(entry)
    expect(registry.select(undefined)).toBe(entry)
  })

  test('multi-entry priority — selects first matching', () => {
    const registry = new StrategyRegistry()
    const first = makeEntry('first', () => false)
    const second = makeEntry('second', () => true)
    const third = makeEntry('third', () => true)
    registry.register(first)
    registry.register(second)
    registry.register(third)

    expect(registry.select(undefined)).toBe(second)
  })

  test('falls back to last entry when none match', () => {
    const registry = new StrategyRegistry()
    const first = makeEntry('first', () => false)
    const second = makeEntry('second', () => false)
    registry.register(first)
    registry.register(second)

    expect(registry.select(undefined)).toBe(second)
  })

  test('canHandle receives model parameter correctly', () => {
    const registry = new StrategyRegistry()
    let receivedModel: Model | undefined

    const entry = makeEntry('spy', (model) => {
      receivedModel = model
      return true
    })
    registry.register(entry)

    const testModel = buildModel('test-model-123')
    registry.select(testModel)

    expect(receivedModel).toBe(testModel)
  })

  test('canHandle receives undefined when no model', () => {
    const registry = new StrategyRegistry()
    let receivedModel: Model | undefined = buildModel('placeholder')

    const entry = makeEntry('spy', (model) => {
      receivedModel = model
      return true
    })
    registry.register(entry)

    registry.select(undefined)
    expect(receivedModel).toBeUndefined()
  })
})

// ── Messages defaultStrategyRegistry ──

describe('messages defaultStrategyRegistry', () => {
  let snapshot: StateSnapshot

  beforeEach(() => {
    snapshot = saveStateSnapshot()
  })

  afterEach(() => {
    restoreStateSnapshot(snapshot)
  })

  test('selects native-messages for model with /v1/messages endpoint', async () => {
    const { defaultStrategyRegistry } = await import('~/routes/messages/strategy-registry')

    const nativeModel = buildModel('claude-sonnet-4', {
      supported_endpoints: ['/v1/messages'],
    })
    modelCache.cacheModels(buildModelsResponse(nativeModel))

    const selected = defaultStrategyRegistry.select(nativeModel)
    expect(selected.name).toBe('native-messages')
  })

  test('selects responses-api for model with /responses endpoint', async () => {
    const { defaultStrategyRegistry } = await import('~/routes/messages/strategy-registry')

    const responsesModel = buildModel('claude-sonnet-4.5', {
      supported_endpoints: ['/responses'],
    })
    modelCache.cacheModels(buildModelsResponse(responsesModel))

    const selected = defaultStrategyRegistry.select(responsesModel)
    expect(selected.name).toBe('responses-api')
  })

  test('selects chat-completions as fallback for model with no supported endpoints', async () => {
    const { defaultStrategyRegistry } = await import('~/routes/messages/strategy-registry')

    const basicModel = buildModel('gpt-5.4')
    modelCache.cacheModels(buildModelsResponse(basicModel))

    const selected = defaultStrategyRegistry.select(basicModel)
    expect(selected.name).toBe('chat-completions')
  })

  test('selects chat-completions when model is undefined', async () => {
    const { defaultStrategyRegistry } = await import('~/routes/messages/strategy-registry')

    const selected = defaultStrategyRegistry.select(undefined)
    expect(selected.name).toBe('chat-completions')
  })

  test('native-messages takes priority over responses-api when both endpoints supported', async () => {
    const { defaultStrategyRegistry } = await import('~/routes/messages/strategy-registry')

    const dualModel = buildModel('claude-sonnet-4', {
      supported_endpoints: ['/v1/messages', '/responses'],
    })
    modelCache.cacheModels(buildModelsResponse(dualModel))

    const selected = defaultStrategyRegistry.select(dualModel)
    expect(selected.name).toBe('native-messages')
  })
})
