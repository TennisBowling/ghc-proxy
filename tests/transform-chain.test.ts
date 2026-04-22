import type { StateSnapshot } from './helpers'

import type { ModelTransformStep } from '~/transform/types'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { modelCache } from '~/state'

import { composeModelTransforms } from '~/transform/chain'
import { buildModel, buildModelsResponse, restoreStateSnapshot, saveStateSnapshot } from './helpers'

// ── Helpers ──

function makeStep(
  tag: string,
  applyFn: ModelTransformStep['apply'],
): ModelTransformStep {
  return { tag, apply: applyFn }
}

function noopStep(tag: string): ModelTransformStep {
  return makeStep(tag, () => null)
}

function rewriteStep(tag: string, toModel: string): ModelTransformStep {
  return makeStep(tag, () => ({ model: toModel, tag }))
}

// ── Tests ──

describe('composeModelTransforms', () => {
  let snapshot: StateSnapshot

  beforeEach(() => {
    snapshot = saveStateSnapshot()
    modelCache.cacheModels(buildModelsResponse(
      buildModel('model-a'),
      buildModel('model-b'),
      buildModel('model-c'),
      buildModel('model-final'),
    ))
  })

  afterEach(() => {
    restoreStateSnapshot(snapshot)
  })

  test('empty steps — returns original model with empty trace', () => {
    const chain = composeModelTransforms()
    const result = chain.apply({ model: 'model-a', payload: {} })

    expect(result.model).toBe('model-a')
    expect(result.trace).toEqual([])
  })

  test('single step that returns null (no-op) — model unchanged', () => {
    const chain = composeModelTransforms(noopStep('noop'))
    const result = chain.apply({ model: 'model-a', payload: {} })

    expect(result.model).toBe('model-a')
    expect(result.trace).toEqual([])
  })

  test('single step with transform — model changed, trace has one entry', () => {
    const chain = composeModelTransforms(rewriteStep('rewrite', 'model-b'))
    const result = chain.apply({ model: 'model-a', payload: {} })

    expect(result.model).toBe('model-b')
    expect(result.trace).toEqual([
      { tag: 'rewrite', from: 'model-a', to: 'model-b' },
    ])
  })

  test('multi-step chain — correct final model and trace order', () => {
    const chain = composeModelTransforms(
      rewriteStep('step-1', 'model-b'),
      rewriteStep('step-2', 'model-c'),
      rewriteStep('step-3', 'model-final'),
    )
    const result = chain.apply({ model: 'model-a', payload: {} })

    expect(result.model).toBe('model-final')
    expect(result.trace).toEqual([
      { tag: 'step-1', from: 'model-a', to: 'model-b' },
      { tag: 'step-2', from: 'model-b', to: 'model-c' },
      { tag: 'step-3', from: 'model-c', to: 'model-final' },
    ])
  })

  test('mutatePayload callback is invoked', () => {
    const step = makeStep('mutator', () => ({
      model: 'model-a',
      tag: 'mutator',
      mutatePayload: (payload: unknown) => {
        (payload as Record<string, unknown>).mutated = true
      },
    }))

    const payload: Record<string, unknown> = { mutated: false }
    const chain = composeModelTransforms(step)
    chain.apply({ model: 'model-a', payload })

    expect(payload.mutated).toBe(true)
  })

  test('resolvedModel is looked up from modelCache when not set by steps', () => {
    const chain = composeModelTransforms(noopStep('noop'))
    const result = chain.apply({ model: 'model-b', payload: {} })

    expect(result.resolvedModel).toBeDefined()
    expect(result.resolvedModel?.id).toBe('model-b')
  })

  test('resolvedModel from step overrides modelCache lookup', () => {
    const customModel = buildModel('custom-resolved')
    const step = makeStep('resolver', () => ({
      model: 'model-b',
      tag: 'resolver',
      resolvedModel: customModel,
    }))

    const chain = composeModelTransforms(step)
    const result = chain.apply({ model: 'model-a', payload: {} })

    expect(result.resolvedModel).toBe(customModel)
  })

  test('resolvedModel falls back to modelCache.findById for final model', () => {
    const chain = composeModelTransforms(rewriteStep('rewrite', 'model-c'))
    const result = chain.apply({ model: 'model-a', payload: {} })

    expect(result.resolvedModel).toBeDefined()
    expect(result.resolvedModel?.id).toBe('model-c')
  })

  test('resolvedModel is undefined when final model is not in cache', () => {
    const chain = composeModelTransforms(rewriteStep('rewrite', 'unknown-model'))
    const result = chain.apply({ model: 'model-a', payload: {} })

    expect(result.resolvedModel).toBeUndefined()
  })

  test('mixed no-op and transform steps — only transforms appear in trace', () => {
    const chain = composeModelTransforms(
      noopStep('skip-1'),
      rewriteStep('apply', 'model-b'),
      noopStep('skip-2'),
    )
    const result = chain.apply({ model: 'model-a', payload: {} })

    expect(result.model).toBe('model-b')
    expect(result.trace).toEqual([
      { tag: 'apply', from: 'model-a', to: 'model-b' },
    ])
  })

  test('step receives current model after previous transforms', () => {
    const receivedModels: string[] = []

    const spyStep = (tag: string, toModel: string): ModelTransformStep =>
      makeStep(tag, (input) => {
        receivedModels.push(input.model)
        return { model: toModel, tag }
      })

    const chain = composeModelTransforms(
      spyStep('s1', 'model-b'),
      spyStep('s2', 'model-c'),
    )
    chain.apply({ model: 'model-a', payload: {} })

    expect(receivedModels).toEqual(['model-a', 'model-b'])
  })
})
