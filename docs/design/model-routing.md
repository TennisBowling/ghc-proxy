# Model Resolution and Routing

This document describes how ghc-proxy resolves model identifiers and routes requests to the appropriate execution path.

## Model Resolution

### Fallback Chain

When a client requests a model ID (e.g., `claude-sonnet-4.6`), the resolver checks:

1. **Exact match** -- If the model ID exists in Copilot's cached model list, use it directly
2. **Family fallback** -- If no exact match, map by model family prefix:
   - `claude-opus-*` → configured `claudeOpus` fallback
   - `claude-sonnet-*` → configured `claudeSonnet` fallback
   - `claude-haiku-*` → configured `claudeHaiku` fallback
3. **Pass-through** -- If no family match, forward the ID as-is (let upstream reject it)

### Configuration

Fallbacks can be configured via environment variables or config file (`~/.ghc-proxy/config.json`):

```text
MODEL_FALLBACK_CLAUDE_OPUS      → config.modelFallback.claudeOpus
MODEL_FALLBACK_CLAUDE_SONNET    → config.modelFallback.claudeSonnet
MODEL_FALLBACK_CLAUDE_HAIKU     → config.modelFallback.claudeHaiku
```

Default fallbacks:
```text
claudeOpus:   claude-opus-4.6
claudeSonnet: claude-sonnet-4.5
claudeHaiku:  claude-haiku-4.5
```

## Model Capabilities

The proxy queries each model's metadata from Copilot's model list to determine:

| Capability              | Used For                                             |
|-------------------------|------------------------------------------------------|
| `supported_endpoints`   | Strategy selection (which execution path to use)     |
| `tool_calls`           | Whether tools can be forwarded                       |
| `vision`               | Whether image inputs are supported                   |
| `adaptive_thinking`    | Whether to fill thinking config                      |
| Vision limits          | Max image tokens, max images per request             |

### Model Endpoint Map (April 30, 2026)

| Model | Endpoints | Notes |
|-------|-----------|-------|
| `claude-opus-4.7` / `-high` / `-xhigh` | `/v1/messages`, `/chat/completions` | 200k ctx; `-xhigh` has 8K cache threshold |
| `claude-opus-4.7-1m-internal` | `/v1/messages`, `/chat/completions` | 1000k ctx |
| `claude-opus-4.6` / `-1m` | `/v1/messages`, `/chat/completions` | |
| `claude-sonnet-4.6` | `/v1/messages`, `/chat/completions` | |
| `gpt-5.5` | `/responses` | Same tool support as gpt-5.4 |
| `gpt-5.4` / `-mini` | `/responses` | |
| `gemini-3.1-pro-preview` | `/chat/completions` | |

## Execution Path Selection

For `POST /v1/messages`, the handler selects a strategy based on the model's `supported_endpoints`:

```text
Does model support /v1/messages?
  ├── YES → Native Messages Strategy (passthrough)
  └── NO
       ├── Does model support /responses?
       │    ├── YES → Responses Translation Strategy
       │    └── NO  → Chat Completions Fallback Strategy
       └── (default) → Chat Completions Fallback Strategy
```

Priority order matters: native passthrough wins when available. The Responses path is used only when it's the best available. Chat Completions is the universal fallback.

## Small-Model Routing

An optional optimization that reroutes certain requests to a smaller (cheaper/faster) model.

## Context Upgrade

When Copilot exposes separate model IDs for extended context (e.g., `claude-opus-4.6-1m`), the proxy can automatically upgrade requests to use the higher-context variant. Three independent signals trigger an upgrade, evaluated in order:

### Signal 1: `anthropic-beta` Header (Proactive)

Clients like Claude Code send `anthropic-beta: context-1m-2025-08-07` to request 1M context. Copilot rejects this header, so the proxy intercepts it:
1. Parse the comma-separated beta values
2. If any value matches `context-<N>k|m-*` and a context upgrade rule exists for the model → upgrade model, strip that beta value
3. Forward remaining beta values to Copilot

This is checked **before** the token-estimation signal. When triggered, the token-estimation signal is skipped via `skipContextUpgrade`.

### Signal 2: Token Estimation (Proactive)

If no beta-header upgrade occurred, the proxy estimates the input token count. When the estimate exceeds the configured threshold (default: 160k tokens), the model is upgraded before sending the request.

### Signal 3: Context Length Error (Reactive)

If Copilot returns a context-length error at runtime, the proxy catches it and retries with the extended-context model variant. This is a last-resort fallback that works regardless of the first two signals.

### Upgrade Rules

Upgrade rules are configured in `config.json` via `contextUpgradeRules`. Rules are evaluated in order, the `from` field supports `*` glob patterns, and the first match wins. Configured targets are trusted even when the target is not present in Copilot's `/models` response, which lets enterprise users opt into internal rollout models without affecting other users.

### Configuration

Context upgrade is controlled by these config options:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `contextUpgrade` | `boolean` | `true` | Enable/disable all three context upgrade signals |
| `contextUpgradeRules` | `{ from, to }[]` | `[]` | Glob-based model upgrade rules |
| `contextUpgradeTokenThreshold` | `number` | `160000` | Token count threshold for proactive upgrade (Signal 2) |

Example `config.json`:
```json
{
  "contextUpgrade": true,
  "contextUpgradeRules": [
    { "from": "claude-opus-4.6", "to": "claude-opus-4.6-1m" }
  ],
  "contextUpgradeTokenThreshold": 160000
}
```

### Small-Model Routing Details

### Activation

Disabled by default. Requires `smallModel` to be set in config.

### Compact Detection

Identifies Claude Code's conversation summarization requests by matching the system prompt pattern. When detected and `compactUseSmallModel` is enabled, the request is rerouted.

### Safety Checks

Before rerouting, the proxy validates the target small model:
- Must exist in Copilot's model list
- Must preserve the original model's endpoint support
- Must support any required capabilities (tools, vision, thinking)

If any check fails, the original model is used.

## Responses Request Policies

The native OpenAI-style `/v1/responses` route stays close to passthrough by default. Two optional request-mutation policies exist for Copilot `/responses` compatibility and long-session ergonomics:

| Key | Default | Effect |
|-----|---------|--------|
| `responsesApiAutoContextManagement` | `false` | Auto-inject `context_management` for models listed in `responsesApiContextManagementModels` |
| `responsesApiAutoCompactInput` | `false` | Auto-trim `input` to the latest `compaction` item before forwarding |

These policies are both disabled by default. They only apply when explicitly enabled in config.

## CAPI Profile Selection

The plan builder selects an API endpoint profile based on model family:

| Model Family | Profile ID | Purpose                                    |
|--------------|------------|--------------------------------------------|
| `claude`     | `claude`   | Claude-specific headers and parameters     |
| (other)      | `base`     | Standard Copilot API headers               |

The profile affects:
- Request headers sent to Copilot
- API base URL construction
- Interaction type defaults
