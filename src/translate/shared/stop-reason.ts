export const OPENAI_TO_ANTHROPIC_STOP_REASON: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'refusal',
}

export function mapStopReason(openaiReason: string | null | undefined): string | null {
  if (openaiReason == null) {
    return null
  }
  return OPENAI_TO_ANTHROPIC_STOP_REASON[openaiReason] ?? null
}
