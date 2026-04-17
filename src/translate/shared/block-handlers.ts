export type BlockHandlerMap<TBlock, TOutput> = Record<string, (block: TBlock) => TOutput | null>

export function dispatchBlock<TBlock extends { type: string }, TOutput>(
  block: TBlock,
  handlers: BlockHandlerMap<TBlock, TOutput>,
  fallback?: (block: TBlock) => TOutput | null,
): TOutput | null {
  const handler = handlers[block.type]
  if (handler) {
    return handler(block)
  }
  return fallback ? fallback(block) : null
}

export function dispatchBlocks<TBlock extends { type: string }, TOutput>(
  blocks: TBlock[],
  handlers: BlockHandlerMap<TBlock, TOutput>,
  fallback?: (block: TBlock) => TOutput | null,
): TOutput[] {
  const results: TOutput[] = []
  for (const block of blocks) {
    const result = dispatchBlock(block, handlers, fallback)
    if (result !== null) {
      results.push(result)
    }
  }
  return results
}
