import type { ModelTransformStep } from './types'
import type { AnthropicMessagesPayload } from '~/translator'

import { applyMessagesModelPolicy } from '~/lib/request-model-policy'
import { modelCache } from '~/state'
import { CONTEXT_BETA_RE } from './constants'

export const modelPolicyStep: ModelTransformStep = {
  tag: 'POLICY',
  apply({ model, payload, meta, resolvedModel }) {
    const betaUpgraded = meta?.betaHeaders?.some(b => CONTEXT_BETA_RE.test(b)) ?? false
    const routing = applyMessagesModelPolicy(payload as AnthropicMessagesPayload, { betaUpgraded })
    if (!routing.reason)
      return null
    return {
      model: routing.routedModel,
      tag: routing.reason === 'context-upgrade' ? 'CONTEXT_UPGRADE' : 'COMPACT',
      resolvedModel: routing.reason === 'context-upgrade'
        ? modelCache.findById(routing.routedModel) ?? resolvedModel ?? modelCache.findById(model)
        : undefined,
    }
  },
}
