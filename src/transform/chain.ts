import type { ModelTransformInput, ModelTransformStep } from './types'
import type { ModelTransformResult } from '~/pipeline/types'

import { modelCache } from '~/state'

export interface ModelTransformChain {
  apply: (input: ModelTransformInput) => ModelTransformResult
}

export function composeModelTransforms(...steps: ModelTransformStep[]): ModelTransformChain {
  return {
    apply(input: ModelTransformInput): ModelTransformResult {
      let current = input.model
      const trace: ModelTransformResult['trace'] = []
      let resolvedModel = input.resolvedModel
      const payload = input.payload

      for (const step of steps) {
        const output = step.apply({ ...input, model: current, payload, resolvedModel })
        if (output === null)
          continue

        const from = current
        const to = output.model

        if (output.mutatePayload) {
          output.mutatePayload(payload)
        }

        if (output.tag) {
          trace.push({ tag: output.tag, from, to })
        }

        current = to
        if (output.resolvedModel !== undefined) {
          resolvedModel = output.resolvedModel
        }
      }

      if (resolvedModel === undefined) {
        resolvedModel = modelCache.findById(current)
      }

      return { model: current, resolvedModel, trace }
    },
  }
}
