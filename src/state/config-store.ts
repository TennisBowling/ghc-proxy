import type { ConfigFile } from '~/lib/config'
import { readConfig } from '~/lib/config'

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
  private config: ConfigFile = {}

  async load(): Promise<void> {
    this.config = await readConfig()
  }

  isEmulatorEnabled(): boolean {
    return this.config.responsesOfficialEmulator ?? DEFAULT_RESPONSES_OFFICIAL_EMULATOR
  }

  getEmulatorTtlSeconds(): number {
    return this.config.responsesOfficialEmulatorTtlSeconds ?? DEFAULT_RESPONSES_OFFICIAL_EMULATOR_TTL_SECONDS
  }

  isContextUpgradeEnabled(): boolean {
    return this.config.contextUpgrade !== false
  }

  getContextUpgradeThreshold(): number {
    return this.config.contextUpgradeTokenThreshold ?? DEFAULT_CONTEXT_UPGRADE_TOKEN_THRESHOLD
  }

  isCompactSmallModelEnabled(): boolean {
    return this.config.compactUseSmallModel ?? DEFAULT_COMPACT_USE_SMALL_MODEL
  }

  getSmallModel(): string | undefined {
    return this.config.smallModel?.trim() || undefined
  }

  isFunctionApplyPatchEnabled(): boolean {
    return this.config.useFunctionApplyPatch ?? DEFAULT_USE_FUNCTION_APPLY_PATCH
  }

  isAutoCompactResponsesInputEnabled(): boolean {
    return this.config.responsesApiAutoCompactInput ?? DEFAULT_RESPONSES_API_AUTO_COMPACT_INPUT
  }

  isContextManagementEnabled(): boolean {
    return this.config.responsesApiAutoContextManagement ?? DEFAULT_RESPONSES_API_AUTO_CONTEXT_MANAGEMENT
  }

  isContextManagementModel(model: string): boolean {
    if (!this.isContextManagementEnabled()) {
      return false
    }
    return this.config.responsesApiContextManagementModels?.includes(model) ?? false
  }

  getReasoningEffort(model: string): ReasoningEffort {
    return this.config.modelReasoningEfforts?.[model] ?? DEFAULT_REASONING_EFFORT
  }

  getModelRewrites(): Array<{ from: string, to: string }> {
    return this.config.modelRewrites ?? []
  }

  getModelFallback(): ConfigFile['modelFallback'] {
    return this.config.modelFallback
  }

  getUpstreamQueueConcurrency(): number | undefined {
    return this.config.upstreamQueueConcurrency
  }

  getUpstreamQueueMaxRetries(): number | undefined {
    return this.config.upstreamQueueMaxRetries
  }

  getUpstreamQueueBaseDelaySeconds(): number | undefined {
    return this.config.upstreamQueueBaseDelaySeconds
  }

  getUpstreamQueueMaxDelaySeconds(): number | undefined {
    return this.config.upstreamQueueMaxDelaySeconds
  }
}

export const configStore = new ConfigStore()
