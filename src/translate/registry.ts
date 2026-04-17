import type { ProtocolTranslator } from './traits'

export type TranslatorKey = string

export class TranslatorRegistry {
  private translators = new Map<TranslatorKey, ProtocolTranslator>()

  register(key: TranslatorKey, translator: ProtocolTranslator): void {
    this.translators.set(key, translator)
  }

  get<T extends ProtocolTranslator = ProtocolTranslator>(key: TranslatorKey): T {
    const translator = this.translators.get(key)
    if (!translator) {
      throw new Error(`No translator registered for key: ${key}`)
    }
    return translator as T
  }

  has(key: TranslatorKey): boolean {
    return this.translators.has(key)
  }
}

export const translatorRegistry = new TranslatorRegistry()
