import { Elysia } from 'elysia'

import { runGuard } from '~/guard'

export const requestGuardPlugin = new Elysia({ name: 'request-guard' })
  .macro({
    guarded: (enabled: boolean) => ({
      async beforeHandle() {
        if (!enabled)
          return
        await runGuard()
      },
    }),
  })
