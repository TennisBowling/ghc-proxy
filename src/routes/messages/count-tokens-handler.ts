import consola from 'consola'

import { inferModelFamily } from '~/core/capi/profile'
import { normalizeAnthropicRequestContext } from '~/core/capi/request-context'
import { fromTranslationFailure, HTTPError } from '~/lib/error'
import { state } from '~/lib/state'
import { getTokenCount } from '~/lib/tokenizer'
import { parseAnthropicCountTokensPayload } from '~/lib/validation'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'

import { createAnthropicAdapter } from './shared'

// Per-family token estimation calibration
const TOOL_OVERHEAD_TOKENS: Record<string, number> = {
  claude: 346, // https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview#pricing
  grok: 480,
  gpt: 346,
}

const ESTIMATION_FACTOR: Record<string, number> = {
  claude: 1.15,
  grok: 1.03,
  gpt: 1.10,
}

export interface CountTokensCoreParams {
  body: unknown
  headers: Headers
}

/**
 * Core handler for counting tokens.
 */
export async function handleCountTokensCore(
  { body, headers }: CountTokensCoreParams,
): Promise<{ input_tokens: number }> {
  const anthropicBeta = headers.get('anthropic-beta') ?? undefined
  const anthropicPayload = parseAnthropicCountTokensPayload(body)
  normalizeAnthropicRequestContext(anthropicPayload, headers)

  const adapter = createAnthropicAdapter()

  let openAIPayload
  try {
    openAIPayload = adapter.toTokenCountPayload(anthropicPayload)
  }
  catch (error) {
    if (error instanceof TranslationFailure) {
      throw fromTranslationFailure(error)
    }
    throw error
  }

  const selectedModel = state.cache.models?.data.find(
    model => model.id === openAIPayload.model,
  )

  if (!selectedModel) {
    throw new HTTPError(400, {
      error: {
        message: `Model not found for token counting: "${openAIPayload.model}"`,
        type: 'invalid_request_error',
      },
    })
  }

  const tokenCount = await getTokenCount(openAIPayload, selectedModel)

  if (anthropicPayload.tools && anthropicPayload.tools.length > 0) {
    let mcpToolExist = false
    if (anthropicBeta?.startsWith('claude-code')) {
      mcpToolExist = anthropicPayload.tools.some(tool =>
        tool.name.startsWith('mcp__'),
      )
    }
    if (!mcpToolExist) {
      const overhead = TOOL_OVERHEAD_TOKENS[inferModelFamily(anthropicPayload.model)]
      if (overhead) {
        tokenCount.input = tokenCount.input + overhead
      }
    }
  }

  let finalTokenCount = tokenCount.input + tokenCount.output
  const factor = ESTIMATION_FACTOR[inferModelFamily(anthropicPayload.model)]
  if (factor) {
    finalTokenCount = Math.round(finalTokenCount * factor)
  }

  consola.info('Token count:', finalTokenCount)

  return {
    input_tokens: finalTokenCount,
  }
}
