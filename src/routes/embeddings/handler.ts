import type { EmbeddingRequest } from '~/types'

import { createCopilotClient } from '~/lib/state'
import { parseEmbeddingRequest } from '~/lib/validation'

function normalizeEmbeddingRequest(payload: EmbeddingRequest): EmbeddingRequest {
  return {
    ...payload,
    input: typeof payload.input === 'string' ? [payload.input] : payload.input,
  }
}

/**
 * Core handler for creating embeddings.
 */
export async function handleEmbeddingsCore(body: unknown): Promise<object> {
  const payload = parseEmbeddingRequest(body)
  const copilotClient = createCopilotClient()
  return await copilotClient.createEmbeddings(normalizeEmbeddingRequest(payload))
}
