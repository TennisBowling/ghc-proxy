import consola from 'consola'

export interface HTTPErrorBody {
  error: {
    message: string
    type: string
    param?: string
    code?: string
    details?: Array<{ path: unknown, message: string }>
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
      : { error: { message: rawText, type: 'upstream_error' } }
  }
  catch {
    body = { error: { message, type: 'upstream_error' } }
  }
  consola.error('Upstream error:', {
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    body,
    rawBody: rawText ? previewBody(rawText) : '<empty>',
  })
  throw new HTTPError(response.status, body)
}
