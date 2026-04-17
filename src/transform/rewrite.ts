import type { ModelTransformOutput, ModelTransformStep } from './types'

import { applyModelRewrite } from '~/lib/model-rewrite'

export const rewriteStep: ModelTransformStep = {
  tag: 'rewrite',
  apply(input): ModelTransformOutput | null {
    const payload = input.payload as { model: string }
    // applyModelRewrite mutates payload.model in place; we restore after to avoid
    // double-mutation (chain.ts handles mutation via mutatePayload)
    const original = payload.model
    payload.model = input.model
    const result = applyModelRewrite(payload)
    // Restore the original so we don't mutate prematurely
    payload.model = original

    if (!result.reason) {
      return null
    }

    return {
      model: result.model,
      tag: result.reason,
      mutatePayload: (p) => {
        ;(p as { model: string }).model = result.model
      },
    }
  },
}
