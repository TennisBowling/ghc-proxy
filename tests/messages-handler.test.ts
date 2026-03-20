import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { getCachedConfig } from '~/lib/config'
import { state } from '~/lib/state'
import { processAnthropicBetaHeader } from '~/routes/messages/handler'

import { buildModel, buildModelsResponse } from './helpers'

// ── Setup / Teardown ──

let originalModels: typeof state.cache.models

function clearConfig() {
  const config = getCachedConfig() as Record<string, unknown>
  for (const key of Object.keys(config)) {
    delete config[key]
  }
}

beforeEach(() => {
  originalModels = state.cache.models
  state.cache.models = buildModelsResponse(
    buildModel('claude-opus-4.6'),
    buildModel('claude-opus-4.6-1m'),
    buildModel('claude-sonnet-4.5'),
  )
  clearConfig()
})

afterEach(() => {
  state.cache.models = originalModels
  clearConfig()
})

// ── processAnthropicBetaHeader ──

describe('processAnthropicBetaHeader', () => {
  test('strips context-* beta when model is already a 1M variant', () => {
    const result = processAnthropicBetaHeader('context-1m-2025-01-01', 'claude-opus-4.6-1m')
    expect(result.header).toBeUndefined()
    expect(result.upgradeTarget).toBeUndefined()
  })

  test('strips context-* beta when model has no upgrade rule at all', () => {
    const result = processAnthropicBetaHeader('context-1m-2025-01-01', 'claude-sonnet-4.5')
    expect(result.header).toBeUndefined()
    expect(result.upgradeTarget).toBeUndefined()
  })

  test('strips context-* beta and upgrades when model has upgrade target', () => {
    const result = processAnthropicBetaHeader('context-1m-2025-01-01', 'claude-opus-4.6')
    expect(result.header).toBeUndefined()
    expect(result.upgradeTarget).toBe('claude-opus-4.6-1m')
  })

  test('preserves non-context betas in header', () => {
    const result = processAnthropicBetaHeader(
      'context-1m-2025-01-01,max-tokens-3-5-sonnet-2024-07-15',
      'claude-opus-4.6',
    )
    expect(result.header).toBe('max-tokens-3-5-sonnet-2024-07-15')
    expect(result.upgradeTarget).toBe('claude-opus-4.6-1m')
  })

  test('returns undefined header when no betas provided', () => {
    const result = processAnthropicBetaHeader(null, 'claude-opus-4.6')
    expect(result.header).toBeUndefined()
    expect(result.upgradeTarget).toBeUndefined()
  })
})
