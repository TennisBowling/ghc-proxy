import type { ModelTransformStep } from './types'

import { getContextUpgradeTarget } from '~/lib/model-rewrite'
import { configStore, modelCache } from '~/state'
import { CONTEXT_BETA_RE } from './constants'

export interface BetaHeaderResult {
  header: string | undefined
  upgradeTarget: string | undefined
}

export function processAnthropicBetaHeader(
  rawHeader: string | null,
  model: string,
): BetaHeaderResult {
  if (!rawHeader)
    return { header: undefined, upgradeTarget: undefined }

  const values = rawHeader.split(',').map(v => v.trim()).filter(Boolean)
  let upgradeTarget: string | undefined
  const filtered: string[] = []

  for (const value of values) {
    if (CONTEXT_BETA_RE.test(value)) {
      // Always strip context-* betas — Copilot doesn't understand them.
      // If context upgrade is enabled and a target exists, apply it.
      if (!upgradeTarget && configStore.isContextUpgradeEnabled()) {
        const target = getContextUpgradeTarget(model)
        if (target) {
          upgradeTarget = target
        }
      }
      continue
    }
    filtered.push(value)
  }

  return {
    header: filtered.length > 0 ? filtered.join(',') : undefined,
    upgradeTarget,
  }
}

export const betaHeaderStep: ModelTransformStep = {
  tag: 'BETA_UPGRADE',
  apply({ model, headers, resolvedModel }) {
    if (!headers)
      return null
    const betaHeader = headers.get('anthropic-beta')
    const result = processAnthropicBetaHeader(betaHeader, model)
    if (!result.upgradeTarget)
      return null
    return {
      model: result.upgradeTarget,
      tag: 'BETA_UPGRADE',
      resolvedModel: modelCache.findById(result.upgradeTarget) ?? resolvedModel ?? modelCache.findById(model),
      mutatePayload(payload: unknown) {
        if (payload && typeof payload === 'object' && 'model' in payload)
          (payload as Record<string, unknown>).model = result.upgradeTarget
      },
    }
  },
}
