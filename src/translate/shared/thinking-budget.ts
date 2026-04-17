export const REASONING_EFFORT_THRESHOLDS = { low: 8000, medium: 24000 } as const

export const ADAPTIVE_DEFAULT_TOKENS = 24000

export function tokensToEffort(tokens: number): 'low' | 'medium' | 'high' {
  if (tokens <= REASONING_EFFORT_THRESHOLDS.low) {
    return 'low'
  }
  if (tokens <= REASONING_EFFORT_THRESHOLDS.medium) {
    return 'medium'
  }
  return 'high'
}

export function effortToTokens(effort: string): number {
  switch (effort) {
    case 'low':
      return REASONING_EFFORT_THRESHOLDS.low
    case 'medium':
      return REASONING_EFFORT_THRESHOLDS.medium
    default:
      return ADAPTIVE_DEFAULT_TOKENS
  }
}
