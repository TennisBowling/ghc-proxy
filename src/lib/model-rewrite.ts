import consola from 'consola'

import { modelCache } from '~/state'

import { getCachedConfig, getContextUpgradeTokenThreshold } from './config'
import { HTTPError } from './error'

// ── Types ──

export interface ModelRewriteResult {
  model: string
  originalModel: string
  reason?: 'AUTO_CORRECT' | 'CONFIG_REWRITE'
}

// ── Pre-request rewriting ──

/**
 * Unified model rewrite: user rules → built-in normalization → pass-through.
 * Call once at handler entry, before any model lookup or policy.
 */
export function rewriteModel(modelId: string): ModelRewriteResult {
  // 1. User-configured rules (first match wins)
  const userRules = getCachedConfig().modelRewrites
  if (userRules) {
    for (const rule of userRules) {
      if (matchesGlob(rule.from, modelId)) {
        const target = normalizeToKnownModel(rule.to) ?? rule.to
        return { originalModel: modelId, model: target, reason: 'CONFIG_REWRITE' }
      }
    }
  }

  // 2. Built-in normalization (dash/dot equivalence)
  const normalized = normalizeToKnownModel(modelId)
  if (normalized && normalized !== modelId) {
    return { originalModel: modelId, model: normalized, reason: 'AUTO_CORRECT' }
  }

  // 3. Pass-through
  return { originalModel: modelId, model: modelId }
}

/**
 * Apply model rewrite to a mutable model field and log if changed.
 * Returns the rewrite result for downstream use.
 */
export function applyModelRewrite(payload: { model: string }): ModelRewriteResult {
  const result = rewriteModel(payload.model)
  if (result.model !== result.originalModel) {
    consola.debug(`Model rewritten: ${result.originalModel} ~> ${result.model}`)
    payload.model = result.model
  }
  return result
}

// ── Built-in normalization ──

const DOT_RE = /\./g

/**
 * Resolve a model ID against Copilot's cached model list using
 * dash/dot equivalence. Returns the canonical ID if found.
 */
function normalizeToKnownModel(modelId: string): string | undefined {
  const models = modelCache.getModels()?.data
  if (!models)
    return undefined

  // Fast path: exact match
  if (models.some(m => m.id === modelId))
    return modelId

  const normalized = modelId.replace(DOT_RE, '-')
  for (const model of models) {
    if (model.id.replace(DOT_RE, '-') === normalized)
      return model.id
  }
  return undefined
}

// ── Glob matching ──

const GLOB_SPECIAL_RE = /[.+^${}()|[\]\\]/g
const GLOB_STAR_RE = /\*/g

function matchesGlob(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) {
    return pattern === value
  }
  const regex = new RegExp(
    `^${pattern.replace(GLOB_SPECIAL_RE, '\\$&').replace(GLOB_STAR_RE, '.*')}$`,
  )
  return regex.test(value)
}

// ── Context upgrade rules (moved from context-upgrade.ts) ──

/** Data-driven upgrade rules. Add new entries to extend. */
const CONTEXT_UPGRADE_RULES: ReadonlyArray<{
  from: string
  to: string
}> = [
  { from: 'claude-opus-4.6', to: 'claude-opus-4.6-1m' },
]

/** Pre-computed set for fast model eligibility checks (avoids token estimation on non-eligible models). */
const UPGRADE_ELIGIBLE_MODELS = new Set(CONTEXT_UPGRADE_RULES.map(r => r.from))

/**
 * Quick check: does this model have any context-upgrade rules?
 * Use to skip expensive token estimation for ineligible models.
 */
export function hasContextUpgradeRule(model: string): boolean {
  return UPGRADE_ELIGIBLE_MODELS.has(model)
}

/** Find the upgrade rule for a model whose target exists in Copilot's model list. */
function findUpgradeRule(model: string) {
  for (const rule of CONTEXT_UPGRADE_RULES) {
    if (model === rule.from && modelCache.findById(rule.to)) {
      return rule
    }
  }
  return undefined
}

/**
 * Proactive: resolve the upgrade target model for a given model + token count.
 * Returns the target model ID, or undefined if no upgrade applies.
 */
export function resolveContextUpgrade(
  model: string,
  estimatedTokens: number,
): string | undefined {
  const rule = findUpgradeRule(model)
  if (rule && estimatedTokens > getContextUpgradeTokenThreshold()) {
    return rule.to
  }
  return undefined
}

/**
 * Reactive: get the upgrade target for a model on context-length error.
 * Returns the target model ID, or undefined if no fallback applies.
 */
export function getContextUpgradeTarget(model: string): string | undefined {
  return findUpgradeRule(model)?.to
}

/** Context-length error detection with pattern matching */
const CONTEXT_ERROR_PATTERNS = [
  /context.length/i,
  /too.long/i,
  /token.*(limit|maximum|exceed)/i,
  /(limit|maximum|exceed).*token/i,
]

export function isContextLengthError(error: unknown): boolean {
  if (!(error instanceof HTTPError) || error.status !== 400) {
    return false
  }
  const message = error.body?.error?.message
  return message ? CONTEXT_ERROR_PATTERNS.some(pattern => pattern.test(message)) : false
}
