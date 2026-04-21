import type { ExecutionResult } from '~/lib/execution-strategy'
import type { Model } from '~/types'

import consola from 'consola'

export interface StrategyEntry<TContext = unknown> {
  name: string
  canHandle: (model: Model | undefined) => boolean
  execute: (ctx: TContext) => Promise<ExecutionResult>
}

export class StrategyRegistry<TContext = unknown> {
  private entries: StrategyEntry<TContext>[] = []

  register(entry: StrategyEntry<TContext>): void {
    this.entries.push(entry)
  }

  select(model: Model | undefined): StrategyEntry<TContext> {
    for (const entry of this.entries) {
      if (entry.canHandle(model)) {
        consola.debug(`Strategy selected: ${entry.name} for model: ${model?.id ?? '(unknown)'}`)
        return entry
      }
    }
    return this.entries.at(-1)!
  }
}
