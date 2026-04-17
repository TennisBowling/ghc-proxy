import type { ExecutionResult } from '~/lib/execution-strategy'
import type { ModelTransformResult } from '~/pipeline/types'

import consola from 'consola'
import { getContextUpgradeTarget, isContextLengthError } from '~/lib/model-rewrite'

export async function executeWithContextRetry(
  executeFn: (model: string) => Promise<ExecutionResult>,
  modelInfo: ModelTransformResult,
): Promise<ExecutionResult> {
  try {
    return await executeFn(modelInfo.model)
  }
  catch (error) {
    if (!isContextLengthError(error))
      throw error
    const upgradeTarget = getContextUpgradeTarget(modelInfo.model)
    if (!upgradeTarget)
      throw error
    consola.info(`Context length error → retrying with ${upgradeTarget}`)
    return await executeFn(upgradeTarget)
  }
}
