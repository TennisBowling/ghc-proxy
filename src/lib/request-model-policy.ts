import type { AnthropicMessagesPayload } from '~/translator'
import type { Model } from '~/types'

import { getSmallModel, shouldCompactUseSmallModel, shouldContextUpgrade } from './config'
import { hasContextUpgradeRule, resolveContextUpgrade } from './context-upgrade'
import {
  findModelById,
  modelSupportsAdaptiveThinking,
  modelSupportsToolCalls,
  modelSupportsVision,
} from './model-capabilities'
import { estimateAnthropicInputTokens } from './tokenizer'

const COMPACT_SYSTEM_PROMPT_START
  = 'You are a helpful AI assistant tasked with summarizing conversations'

export interface ModelRoutingResult {
  originalModel: string
  routedModel: string
  reason?: 'compact' | 'context-upgrade'
}

export function applyMessagesModelPolicy(
  payload: AnthropicMessagesPayload,
): ModelRoutingResult {
  const originalModel = payload.model

  // Context upgrade: route to extended-context variant for large payloads.
  // Checked first because it is independent of smallModel configuration.
  if (shouldContextUpgrade() && hasContextUpgradeRule(payload.model)) {
    const contextUpgradeTarget = resolveContextUpgrade(
      payload.model,
      estimateAnthropicInputTokens(payload),
    )
    if (contextUpgradeTarget) {
      payload.model = contextUpgradeTarget
      return { originalModel, routedModel: contextUpgradeTarget, reason: 'context-upgrade' }
    }
  }

  // Small-model routing (compact) requires a configured smallModel and enabled flag.
  const smallModel = getSmallModel()
  if (!smallModel || !shouldCompactUseSmallModel() || !isCompactRequest(payload)) {
    return { originalModel, routedModel: originalModel }
  }

  const originalSelection = findModelById(originalModel)
  const smallSelection = findModelById(smallModel)

  if (canRouteToSmallModel(payload, originalSelection, smallSelection)) {
    payload.model = smallModel
    return {
      originalModel,
      routedModel: smallModel,
      reason: 'compact',
    }
  }

  return { originalModel, routedModel: originalModel }
}

export function isCompactRequest(payload: AnthropicMessagesPayload): boolean {
  if (typeof payload.system === 'string') {
    return payload.system.startsWith(COMPACT_SYSTEM_PROMPT_START)
  }
  if (!Array.isArray(payload.system)) {
    return false
  }
  return payload.system.some(
    block => typeof block.text === 'string'
      && block.text.startsWith(COMPACT_SYSTEM_PROMPT_START),
  )
}

function canRouteToSmallModel(
  payload: AnthropicMessagesPayload,
  originalModel: Model | undefined,
  smallModel: Model | undefined,
): boolean {
  if (!originalModel || !smallModel) {
    return false
  }

  const originalEndpoints = new Set(originalModel.supported_endpoints ?? [])
  const smallEndpoints = new Set(smallModel.supported_endpoints ?? [])
  for (const endpoint of originalEndpoints) {
    if (!smallEndpoints.has(endpoint)) {
      return false
    }
  }

  if (payload.tools?.length && !modelSupportsToolCalls(smallModel)) {
    return false
  }

  if (payload.thinking && !modelSupportsAdaptiveThinking(smallModel)) {
    return false
  }

  if (hasVisionInput(payload) && !modelSupportsVision(smallModel)) {
    return false
  }

  return true
}

function hasVisionInput(payload: AnthropicMessagesPayload): boolean {
  return payload.messages.some(message => containsVisionContent(message.content))
}

function containsVisionContent(content: AnthropicMessagesPayload['messages'][number]['content']): boolean {
  if (!Array.isArray(content)) {
    return false
  }

  return content.some(block => block.type === 'image')
}
