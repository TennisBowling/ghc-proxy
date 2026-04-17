import type { Model } from '~/types'

import { fromTranslationFailure, HTTPError, throwInvalidRequestError } from '~/lib/error'
import { modelCache } from '~/state'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'

/**
 * Resolves a model by ID from the cache or throws a 400 invalid request error.
 * Replaces scattered `!selectedModel` null checks across route handlers.
 */
export function resolveModelOrThrow(modelId: string): Model {
  const model = modelCache.findById(modelId)
  if (!model) {
    throwInvalidRequestError('The selected model could not be resolved.', 'model')
  }
  return model
}

/**
 * Wraps a function call and converts any TranslationFailure into an HTTPError.
 * Replaces identical try-catch blocks across route handlers.
 */
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

/**
 * Converts any error into a Response.
 * Handles HTTPError, TranslationFailure, and generic errors (500).
 */
export function formatErrorResponse(error: unknown): Response {
  if (error instanceof HTTPError) {
    return error.toResponse()
  }
  if (error instanceof TranslationFailure) {
    return fromTranslationFailure(error).toResponse()
  }
  return Response.json(
    { error: { message: 'Internal server error', type: 'server_error' } },
    { status: 500 },
  )
}
