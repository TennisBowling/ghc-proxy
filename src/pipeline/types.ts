import type { Model } from '~/types'

export interface ModelTransformRecord {
  tag: string
  from: string
  to: string
}

export interface ModelTransformResult {
  model: string
  resolvedModel?: Model
  trace: ModelTransformRecord[]
}

export interface RawRequest {
  body: unknown
  headers: Headers
  signal: AbortSignal
}
