import type { StateSnapshot } from './helpers'

import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ModelTransformResult } from '~/pipeline/types'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { executeWithContextRetry } from '~/dispatch/error-recovery'
import { getCachedConfig } from '~/lib/config'
import { HTTPError } from '~/lib/error'

import { modelCache } from '~/state'
import { buildModel, buildModelsResponse, clearConfig, restoreStateSnapshot, saveStateSnapshot } from './helpers'

// ── Helpers ──

function makeContextLengthError(): HTTPError {
  return new HTTPError(400, {
    error: {
      message: 'The request context length exceeds the maximum allowed',
      type: 'invalid_request_error',
    },
  })
}

function makeGenericError(): Error {
  return new Error('Something went wrong')
}

function makeSuccessResult(): ExecutionResult {
  return { kind: 'json', data: { content: 'ok' } }
}

function makeModelInfo(model: string): ModelTransformResult {
  return {
    model,
    resolvedModel: modelCache.findById(model),
    trace: [],
  }
}

// ── Tests ──

describe('executeWithContextRetry', () => {
  let snapshot: StateSnapshot

  beforeEach(() => {
    snapshot = saveStateSnapshot()
    // Set up models with an upgrade rule: claude-opus-4.6 → claude-opus-4.6-1m
    modelCache.cacheModels(buildModelsResponse(
      buildModel('claude-opus-4.6'),
      buildModel('claude-opus-4.6-1m'),
      buildModel('claude-sonnet-4.5'),
    ))
    clearConfig()
    const config = getCachedConfig() as Record<string, unknown>
    config.contextUpgradeRules = [{ from: 'claude-opus-4.6', to: 'claude-opus-4.6-1m' }]
  })

  afterEach(() => {
    restoreStateSnapshot(snapshot)
    clearConfig()
  })

  test('success path — returns result without retry', async () => {
    const result = makeSuccessResult()
    const executeFn = () => Promise.resolve(result)

    const output = await executeWithContextRetry(executeFn, makeModelInfo('claude-opus-4.6'))
    expect(output).toBe(result)
  })

  test('non-context error is re-thrown', async () => {
    const error = makeGenericError()
    const executeFn = () => Promise.reject(error)

    await expect(
      executeWithContextRetry(executeFn, makeModelInfo('claude-opus-4.6')),
    ).rejects.toThrow('Something went wrong')
  })

  test('context error with upgrade target — retries and succeeds', async () => {
    const successResult = makeSuccessResult()
    let callCount = 0

    const executeFn = (model: string) => {
      callCount++
      if (callCount === 1) {
        return Promise.reject(makeContextLengthError())
      }
      // Verify retry uses the upgrade target
      expect(model).toBe('claude-opus-4.6-1m')
      return Promise.resolve(successResult)
    }

    const output = await executeWithContextRetry(executeFn, makeModelInfo('claude-opus-4.6'))
    expect(output).toBe(successResult)
    expect(callCount).toBe(2)
  })

  test('context error without configured upgrade rule — error re-thrown', async () => {
    const config = getCachedConfig() as Record<string, unknown>
    config.contextUpgradeRules = []

    const executeFn = () => Promise.reject(makeContextLengthError())

    await expect(
      executeWithContextRetry(executeFn, makeModelInfo('claude-opus-4.6')),
    ).rejects.toBeInstanceOf(HTTPError)
  })
  test('context error with no upgrade target — error re-thrown', async () => {
    const executeFn = () => Promise.reject(makeContextLengthError())

    // claude-sonnet-4.5 has no upgrade rule
    await expect(
      executeWithContextRetry(executeFn, makeModelInfo('claude-sonnet-4.5')),
    ).rejects.toBeInstanceOf(HTTPError)
  })

  test('context error with context upgrade disabled — error re-thrown', async () => {
    // Disable context upgrade via config
    const config = getCachedConfig() as Record<string, unknown>
    config.contextUpgrade = false

    const executeFn = () => Promise.reject(makeContextLengthError())

    // Even though claude-opus-4.6 has an upgrade rule, config disables it
    await expect(
      executeWithContextRetry(executeFn, makeModelInfo('claude-opus-4.6')),
    ).rejects.toBeInstanceOf(HTTPError)
  })

  test('non-HTTPError 400 is re-thrown without retry', async () => {
    // A non-HTTPError won't be recognized as context-length error
    const error = new HTTPError(500, {
      error: {
        message: 'Context length exceeded',
        type: 'server_error',
      },
    })
    const executeFn = () => Promise.reject(error)

    await expect(
      executeWithContextRetry(executeFn, makeModelInfo('claude-opus-4.6')),
    ).rejects.toBeInstanceOf(HTTPError)
  })

  test('context error retry — executeFn is called with original model first', async () => {
    const models: string[] = []

    const executeFn = (model: string) => {
      models.push(model)
      if (models.length === 1) {
        return Promise.reject(makeContextLengthError())
      }
      return Promise.resolve(makeSuccessResult())
    }

    await executeWithContextRetry(executeFn, makeModelInfo('claude-opus-4.6'))
    expect(models).toEqual(['claude-opus-4.6', 'claude-opus-4.6-1m'])
  })
})
