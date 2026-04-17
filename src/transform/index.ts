import { betaHeaderStep } from './beta-headers'
import { composeModelTransforms } from './chain'
import { modelPolicyStep } from './policy'
import { rewriteStep } from './rewrite'

export { betaHeaderStep } from './beta-headers'
export { composeModelTransforms } from './chain'
export type { ModelTransformChain } from './chain'
export { modelPolicyStep } from './policy'
export { rewriteStep } from './rewrite'
export type { ModelTransformInput, ModelTransformOutput, ModelTransformStep } from './types'

export const messagesModelChain = composeModelTransforms(
  rewriteStep,
  betaHeaderStep,
  modelPolicyStep,
)

export const chatCompletionsModelChain = composeModelTransforms(
  rewriteStep,
)

export const responsesModelChain = composeModelTransforms(
  rewriteStep,
)
