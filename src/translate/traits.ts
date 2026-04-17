import type { TranslationPolicy } from '~/translator/anthropic/translation-policy'

export interface ProtocolTranslator<TSource = unknown, TTarget = unknown, TSourceChunk = unknown, TTargetChunk = unknown> {
  translateRequest: (source: TSource, policy?: TranslationPolicy) => TTarget
  translateResponse: (result: unknown) => unknown
  createStreamTranslator: () => StreamTranslator<TSourceChunk, TTargetChunk>
}

export interface StreamTranslator<TSourceChunk = unknown, TTargetChunk = unknown> {
  onChunk: (chunk: TSourceChunk) => TTargetChunk | TTargetChunk[] | null
  onDone: () => TTargetChunk | TTargetChunk[] | null
  onError?: (error: unknown) => TTargetChunk | TTargetChunk[] | null
}
