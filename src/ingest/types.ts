export type ProtocolId
  = | 'anthropic-messages'
    | 'anthropic-count-tokens'
    | 'openai-chat'
    | 'responses'
    | 'responses-input-tokens'
    | 'embeddings'

export interface RequestMeta {
  sessionId?: string
  subagentInfo?: unknown
  betaHeaders?: string[]
  requestContext?: unknown
}

export interface ProtocolHandler<TPayload = unknown> {
  parse: (body: unknown) => TPayload
  extractMeta: (payload: TPayload, headers: Headers) => RequestMeta
}

export interface IngestedRequest<TPayload = unknown> {
  protocol: ProtocolId
  payload: TPayload
  meta: RequestMeta
}
