import type { ExecutionStrategy } from '~/lib/execution-strategy'
import type { Model } from '~/types'

import consola from 'consola'

export interface StrategyEntry {
  name: string
  canHandle: (model: Model | undefined) => boolean
  createStrategy: (...args: any[]) => ExecutionStrategy<any, any>
}

export class StrategyRegistry {
  private entries: StrategyEntry[] = []

  register(entry: StrategyEntry): void {
    this.entries.push(entry)
  }

  select(model: Model | undefined): StrategyEntry {
    for (const entry of this.entries) {
      if (entry.canHandle(model)) {
        consola.debug(`Strategy selected: ${entry.name} for model: ${model?.id ?? '(unknown)'}`)
        return entry
      }
    }
    return this.entries.at(-1)!
  }
}
