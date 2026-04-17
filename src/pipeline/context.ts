import type { ModelTransformResult } from './types'
import type { CopilotClient } from '~/clients'

import { createCopilotClient } from '~/lib/state'
import { createUpstreamSignalFromConfig } from '~/lib/upstream-signal'

export interface StrategyContext {
  payload: unknown
  modelInfo: ModelTransformResult
  signal: AbortSignal
  copilotClient: CopilotClient
  upstreamSignal: ReturnType<typeof createUpstreamSignalFromConfig>
  headers: Headers
}

export function createStrategyContext(input: {
  payload: unknown
  modelInfo: ModelTransformResult
  signal: AbortSignal
  headers: Headers
}): StrategyContext {
  return {
    ...input,
    copilotClient: createCopilotClient(),
    upstreamSignal: createUpstreamSignalFromConfig(input.signal),
  }
}
