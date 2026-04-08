# Error Handling and Validation

This document describes the error handling strategy and validation architecture.

## Error Classification

### Validation Errors (400)

Caught at request ingress via Zod schemas:

- Missing required fields
- Type mismatches (string where number expected, etc.)
- Invalid enum values
- Referential integrity (e.g., `tool_choice.name` references a declared tool)
- Positive `thinking.budget_tokens`
- Object-shaped tool schemas
- Image block base64 source shape
- `tool_result` content structure

### Translation Errors (400)

Caught during protocol translation:

- **Strict mode**: Lossy translations that would lose semantics (e.g., thinking history omission)
- **Always**: Explicitly unsupported fields (e.g., `top_k`, `service_tier` on Responses path, `stop_sequences` on Responses path)

### Upstream Errors (Pass-through)

Errors from GitHub Copilot's API are forwarded to the client with the upstream status code and body:

```typescript
class HTTPError extends Error {
  status: number        // HTTP status code
  body: HTTPErrorBody   // Structured error payload
}
```

The upstream error helper (`throwUpstreamError`) extracts the response body and status code. If the upstream body is empty or non-JSON, the client gets the fallback proxy error message while logs still include upstream status metadata and a safe body preview.

### Streaming Errors

During streaming, errors become protocol-level events:

```json
{
  "type": "error",
  "error": {
    "type": "api_error",
    "message": "Malformed upstream JSON in chunk"
  }
}
```

This preserves the SSE connection and gives the client structured error information.

## Validation Architecture

### Zod Schemas (`src/lib/validation/`)

All request payloads are validated at the route handler level:

| Schema                         | Endpoint                    |
|--------------------------------|-----------------------------|
| `ChatCompletionsPayload`      | `POST /chat/completions`   |
| `AnthropicMessagesPayload`    | `POST /v1/messages`        |
| `ResponsesPayload`           | `POST /v1/responses`       |
| `EmbeddingRequest`            | `POST /v1/embeddings`      |

Key validations:
- Tool schemas must be object-typed
- Tool choice references must match declared tools
- Thinking budget must be positive
- Image sources must have valid base64 data
- Message roles must follow protocol rules
- Embeddings accept the official OpenAI-facing `string | string[]` input shape
- Embedding-specific optional fields such as `dimensions`, `encoding_format`, and `user` are modeled explicitly

### Translation Policy (`src/translator/anthropic/translation-policy.ts`)

```typescript
interface TranslationPolicy {
  mode: 'best-effort' | 'strict'
}

class TranslationContext {
  record(issue: TranslationIssue, options?: { fatalInStrict?: boolean })
  getIssues(): TranslationIssue[]
}
```

**best-effort mode** (default): Lossy translations are recorded but allowed. The proxy does its best to preserve semantics.

**strict mode**: Lossy translations marked as `fatalInStrict` throw `TranslationFailure` with status 400. Used when the caller demands exact translation fidelity.

### Translation Issue Types

```typescript
interface TranslationIssue {
  kind: string                         // e.g., 'unsupported_stop_sequences'
  severity: 'info' | 'warning' | 'error'
  message: string                      // Human-readable description
}
```

Issue kinds used in the codebase:

| Kind                                    | Severity    | Description                                           |
|-----------------------------------------|-------------|-------------------------------------------------------|
| `lossy_thinking_omitted_from_prompt`   | warning     | Thinking history blocks removed from upstream prompt  |
| `lossy_interleaving_flattened`         | warning     | Text/tool_use interleaving flattened in assistant turn |
| `lossy_multiple_choices_ignored`       | warning     | Only choice[0] used from multi-choice response        |
| `unsupported_top_k`                    | error       | `top_k` parameter cannot be translated                |
| `unsupported_service_tier`             | error       | `service_tier` parameter cannot be translated         |
| `unsupported_stop_sequences`           | error       | `stop_sequences` cannot be forwarded on Responses path |

## Error Classes

### `HTTPError`

Elysia-native error class with `status` property and `toResponse()`. Elysia auto-handles this via `toResponse()` when thrown in route handlers:

```typescript
class HTTPError extends Error {
  status: number       // HTTP status code
  body: HTTPErrorBody  // Structured { error: { message, type, param?, code? } }

  toResponse(): Response  // Returns Response.json(body, { status })
}
```

### `TranslationFailure`

Thrown when a translation issue is fatal:

```typescript
class TranslationFailure extends Error {
  status: 400 | 502   // HTTP status code
  kind: string         // Issue kind (e.g., 'unsupported_stop_sequences')
}
```

### `throwInvalidRequestError()`

Convenience for Anthropic-format validation errors:

```typescript
function throwInvalidRequestError(
  message: string,
  param: string,
  code?: string
): never
```

Throws an `HTTPError` that Elysia converts to:
```json
{
  "error": {
    "type": "invalid_request_error",
    "message": "...",
    "param": "..."
  }
}
```

## Error Flow

```text
Request arrives
    |
    v
[Zod Validation] ──fail──> 400 { type: invalid_request_error }
    |
    v (valid)
[Translation Policy Check] ──unsupported──> 400 { type: invalid_request_error }
    |
    v (ok)
[Upstream Request]
    |
    +── HTTP error ──> forward upstream status + body
    |
    +── Network error ──> 502
    |
    +── Timeout ──> 504
    |
    v (success)
[Response Translation]
    |
    +── Non-streaming error ──> 502
    |
    +── Streaming error ──> SSE error event (not TCP break)
    |
    v
Client Response
```

## Compatibility Normalization

Validation and request shaping also preserve the public API contract when Copilot upstream differs from the exposed schema. Example: `POST /v1/embeddings` accepts OpenAI-compatible single-string input, then normalizes it to a one-element array before the upstream call.
