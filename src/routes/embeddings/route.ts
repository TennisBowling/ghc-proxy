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
