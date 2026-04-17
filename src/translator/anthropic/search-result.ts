import type { AnthropicSearchResultBlock } from './types'

export function formatSearchResultBlock(block: AnthropicSearchResultBlock): string {
  const content = block.content
    .map(part => part.text.trim())
    .filter(Boolean)
    .join('\n')

  return [
    '[search result]',
    `Title: ${block.title}`,
    `Source: ${block.source}`,
    content ? `Content:\n${content}` : undefined,
  ].filter((part): part is string => Boolean(part)).join('\n')
}
