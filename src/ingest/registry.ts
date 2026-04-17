import type { IngestedRequest, ProtocolHandler, ProtocolId } from './types'

export class ProtocolRegistry {
  private readonly handlers = new Map<ProtocolId, ProtocolHandler>()

  register<TPayload>(id: ProtocolId, handler: ProtocolHandler<TPayload>): void {
    this.handlers.set(id, handler as ProtocolHandler)
  }

  ingest<TPayload = unknown>(
    id: ProtocolId,
    body: unknown,
    headers: Headers,
  ): IngestedRequest<TPayload> {
    const handler = this.handlers.get(id)
    if (!handler) {
      throw new Error(`No handler registered for protocol: ${id}`)
    }

    const payload = handler.parse(body) as TPayload
    const meta = handler.extractMeta(payload, headers)

    return { protocol: id, payload, meta }
  }
}
