import type { ProtocolHandler, RequestMeta } from './types'
import type { EmbeddingRequest } from '~/types'

import { parseEmbeddingRequest } from '~/lib/validation'

export const embeddingsProtocol: ProtocolHandler<EmbeddingRequest> = {
  parse(body: unknown): EmbeddingRequest {
    return parseEmbeddingRequest(body)
  },
  extractMeta(_payload: EmbeddingRequest, _headers: Headers): RequestMeta {
    return {}
  },
}
