import { Elysia } from 'elysia'

import { setRequestModelMapping } from '~/lib/request-logger'
import { disableIdleTimeout, hasStreamingFlag, hasStreamingResponsesQuery } from '~/lib/request-timeout'
import { sseAdapter } from '~/lib/sse-adapter'
import { requestGuardPlugin } from '~/routes/middleware/request-guard'

import { handleResponsesCore } from './handler'
import {
  handleCreateResponseInputTokensCore,
  handleDeleteResponseCore,
  handleListResponseInputItemsCore,
  handleRetrieveResponseCore,
} from './resource-handler'

export function createResponsesRoutes() {
  return new Elysia()
    .use(requestGuardPlugin)
    .post('/responses', async function* ({ body, request, server }) {
      if (hasStreamingFlag(body)) {
        disableIdleTimeout(server, request)
      }

      const { result, modelMapping } = await handleResponsesCore({
        body,
        signal: request.signal,
        headers: request.headers,
      })
      if (modelMapping)
        setRequestModelMapping(request, modelMapping)
      if (result.kind === 'json') {
        return result.data
      }
      yield* sseAdapter(result.generator)
    }, { guarded: true })
    .post('/responses/input_tokens', async ({ body, request }) => {
      return handleCreateResponseInputTokensCore({
        body,
        headers: request.headers,
        signal: request.signal,
      })
    }, { guarded: true })
    .get('/responses/:responseId/input_items', async ({ params, request }) => {
      return handleListResponseInputItemsCore({
        params,
        url: request.url,
        headers: request.headers,
        signal: request.signal,
      })
    })
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
    })
    .delete('/responses/:responseId', async ({ params, request }) => {
      return handleDeleteResponseCore({
        params,
        headers: request.headers,
        signal: request.signal,
      })
    })
}
