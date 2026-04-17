import { getCachedConfig } from '~/lib/config'

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'high'
const DEFAULT_COMPACT_USE_SMALL_MODEL = false
const DEFAULT_USE_FUNCTION_APPLY_PATCH = true
const DEFAULT_RESPONSES_API_AUTO_COMPACT_INPUT = false
const DEFAULT_RESPONSES_API_AUTO_CONTEXT_MANAGEMENT = false
const DEFAULT_RESPONSES_OFFICIAL_EMULATOR = false
const DEFAULT_RESPONSES_OFFICIAL_EMULATOR_TTL_SECONDS = 14_400
const DEFAULT_CONTEXT_UPGRADE_TOKEN_THRESHOLD = 160_000

export class ConfigStore {
  isEmulatorEnabled(): boolean {
    return getCachedConfig().responsesOfficialEmulator ?? DEFAULT_RESPONSES_OFFICIAL_EMULATOR
  }

  getEmulatorTtlSeconds(): number {
    return getCachedConfig().responsesOfficialEmulatorTtlSeconds ?? DEFAULT_RESPONSES_OFFICIAL_EMULATOR_TTL_SECONDS
  }

  isContextUpgradeEnabled(): boolean {
    return getCachedConfig().contextUpgrade !== false
  }

  getContextUpgradeThreshold(): number {
    return getCachedConfig().contextUpgradeTokenThreshold ?? DEFAULT_CONTEXT_UPGRADE_TOKEN_THRESHOLD
  }

  isCompactSmallModelEnabled(): boolean {
    return getCachedConfig().compactUseSmallModel ?? DEFAULT_COMPACT_USE_SMALL_MODEL
  }

  getSmallModel(): string | undefined {
    return getCachedConfig().smallModel?.trim() || undefined
  }

  isFunctionApplyPatchEnabled(): boolean {
    return getCachedConfig().useFunctionApplyPatch ?? DEFAULT_USE_FUNCTION_APPLY_PATCH
  }

  isAutoCompactResponsesInputEnabled(): boolean {
    return getCachedConfig().responsesApiAutoCompactInput ?? DEFAULT_RESPONSES_API_AUTO_COMPACT_INPUT
  }

  isContextManagementEnabled(): boolean {
    return getCachedConfig().responsesApiAutoContextManagement ?? DEFAULT_RESPONSES_API_AUTO_CONTEXT_MANAGEMENT
  }

  isContextManagementModel(model: string): boolean {
    if (!this.isContextManagementEnabled()) {
      return false
    }
    return getCachedConfig().responsesApiContextManagementModels?.includes(model) ?? false
  }

  getReasoningEffort(model: string): ReasoningEffort {
    return getCachedConfig().modelReasoningEfforts?.[model] ?? DEFAULT_REASONING_EFFORT
  }

  getModelRewrites(): Array<{ from: string, to: string }> {
    return getCachedConfig().modelRewrites ?? []
  }

  getModelFallback() {
    return getCachedConfig().modelFallback
  }

  getUpstreamQueueConcurrency(): number | undefined {
    return getCachedConfig().upstreamQueueConcurrency
  }

  getUpstreamQueueMaxRetries(): number | undefined {
    return getCachedConfig().upstreamQueueMaxRetries
  }

  getUpstreamQueueBaseDelaySeconds(): number | undefined {
    return getCachedConfig().upstreamQueueBaseDelaySeconds
  }

  getUpstreamQueueMaxDelaySeconds(): number | undefined {
    return getCachedConfig().upstreamQueueMaxDelaySeconds
  }
}

export const configStore = new ConfigStore()
