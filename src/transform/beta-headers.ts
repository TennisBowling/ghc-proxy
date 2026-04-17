import type { ModelTransformStep } from './types'

import { processAnthropicBetaHeader } from '~/routes/messages/handler'

export const betaHeaderStep: ModelTransformStep = {
  tag: 'BETA_UPGRADE',
  apply({ model, headers }) {
    if (!headers)
      return null
    const betaHeader = headers.get('anthropic-beta')
    const result = processAnthropicBetaHeader(betaHeader, model)
    if (!result.upgradeTarget)
      return null
    return {
      model: result.upgradeTarget,
      mutatePayload(payload: unknown) {
        if (payload && typeof payload === 'object' && 'model' in payload)
          (payload as Record<string, unknown>).model = result.upgradeTarget
      },
    }
  },
}
