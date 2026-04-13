import consola from 'consola'

function createNoopLogFn(): typeof consola.warn {
  return Object.assign(() => {}, { raw: () => {} }) as unknown as typeof consola.warn
}

consola.warn = createNoopLogFn()
consola.error = createNoopLogFn()
