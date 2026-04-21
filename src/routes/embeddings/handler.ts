import type { EmbeddingRequest } from '~/types'

import { protocolRegistry } from '~/ingest'
import { createCopilotClient } from '~/lib/state'

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
  const { payload } = protocolRegistry.ingest<EmbeddingRequest>(
    'embeddings',
    body,
    new Headers(),
  )
  const copilotClient = createCopilotClient()
  return await copilotClient.createEmbeddings(normalizeEmbeddingRequest(payload))
}
