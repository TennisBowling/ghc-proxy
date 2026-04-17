import type { ModelTransformStep } from './types'
import type { AnthropicMessagesPayload } from '~/translator'

import { applyMessagesModelPolicy } from '~/lib/request-model-policy'

const CONTEXT_BETA_RE = /^context-\d+[km]-/

export const modelPolicyStep: ModelTransformStep = {
  tag: 'POLICY',
  apply({ payload, meta }) {
    const betaUpgraded = meta?.betaHeaders?.some(b => CONTEXT_BETA_RE.test(b)) ?? false
    const routing = applyMessagesModelPolicy(payload as AnthropicMessagesPayload, { betaUpgraded })
    if (!routing.reason)
      return null
    return {
      model: routing.routedModel,
      tag: routing.reason === 'context-upgrade' ? 'CONTEXT_UPGRADE' : 'COMPACT',
    }
  },
}
