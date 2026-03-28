interface TimeoutCapableServer {
  timeout?: ((request: Request, seconds: number) => void) | undefined
}

export function disableIdleTimeout(
  server: TimeoutCapableServer | null | undefined,
  request: Request,
): void {
  if (typeof server?.timeout === 'function') {
    server.timeout(request, 0)
  }
}

export function hasStreamingFlag(body: unknown): boolean {
  if (!body || typeof body !== 'object') {
    return false
  }

  return (body as Record<string, unknown>).stream === true
}

export function hasStreamingResponsesQuery(request: Pick<Request, 'url'>): boolean {
  return new URL(request.url).searchParams.get('stream') === 'true'
}
