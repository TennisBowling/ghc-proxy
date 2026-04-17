import consola from 'consola'

export interface HTTPErrorBody {
  error: {
    message: string
    type: string
    param?: string
    code?: string
    details?: Array<{
      path: unknown
      message: string
      code?: string
      expected?: unknown
    }>
  }
}

/**
 * Elysia-native error class with `status` property and `toResponse()`.
 * Elysia auto-handles this via `toResponse()` when thrown in route handlers.
 */
export class HTTPError extends Error {
  readonly status: number
  readonly body: HTTPErrorBody

  constructor(status: number, body: HTTPErrorBody) {
    super(body.error.message)
    this.name = 'HTTPError'
    this.status = status
    this.body = body
  }

  toResponse() {
    return Response.json(this.body, { status: this.status })
  }
}

export function throwInvalidRequestError(
  message: string,
  param: string,
  code?: string,
): never {
  throw new HTTPError(400, {
    error: {
      message,
      type: 'invalid_request_error',
      param,
      ...(code ? { code } : {}),
    },
  })
}

export function fromTranslationFailure(failure: { message: string, status: number }): HTTPError {
  return new HTTPError(failure.status, {
    error: { message: failure.message, type: 'translation_error' },
  })
}

function previewBody(text: string, maxLength = 500): string {
  return text.length > maxLength
    ? `${text.slice(0, maxLength)}…`
    : text
}

function isStructuredErrorPayload(
  value: unknown,
): value is { error: Record<string, unknown> } {
  return typeof value === 'object'
    && value !== null
    && 'error' in value
    && typeof value.error === 'object'
    && value.error !== null
}

function upstreamErrorType(status: number): string {
  return status === 429 ? 'rate_limit_error' : 'upstream_error'
}

function createFallbackUpstreamError(
  message: string,
  response: Response,
  rawText: string,
): HTTPErrorBody {
  const upstreamMessage = rawText.trim()
  return {
    error: {
      message: upstreamMessage || message,
      type: upstreamErrorType(response.status),
    },
  }
}

function getDiagnosticHeaders(response: Response): Record<string, string> | undefined {
  const headerNames = [
    'retry-after',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
    'x-github-request-id',
    'x-request-id',
  ]
  const headers: Record<string, string> = {}
  for (const name of headerNames) {
    const value = response.headers.get(name)
    if (value) {
      headers[name] = value
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

/**
 * Read an upstream Response body and throw an HTTPError with structured payload.
 * Used by CopilotClient when upstream returns a non-OK response.
 */
export async function throwUpstreamError(message: string, response: Response): Promise<never> {
  let rawText = ''
  let body: HTTPErrorBody
  try {
    rawText = await response.text()
    const json = JSON.parse(rawText)
    body = isStructuredErrorPayload(json)
      ? json as HTTPErrorBody
      : createFallbackUpstreamError(message, response, rawText)
  }
  catch {
    body = createFallbackUpstreamError(message, response, rawText)
  }
  consola.error('Upstream error:', {
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    body,
    rawBody: rawText ? previewBody(rawText) : '<empty>',
    headers: getDiagnosticHeaders(response),
  })
  throw new HTTPError(response.status, body)
}
