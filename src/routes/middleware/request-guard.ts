import { Elysia } from 'elysia'

import { awaitApproval } from '~/lib/approval'
import { authStore, rateLimiter } from '~/state'

/**
 * Elysia macro for request guard middleware.
 * Usage: `.use(requestGuardPlugin)` then `.post('/path', handler, { guarded: true })`
 */
export const requestGuardPlugin = new Elysia({ name: 'request-guard' })
  .macro({
    guarded: (enabled: boolean) => ({
      async beforeHandle() {
        if (!enabled)
          return
        await runRequestGuard()
      },
    }),
  })

/**
 * Core request guard logic.
 * Checks rate limits and optionally awaits manual approval.
 * Exported for direct use where the plugin is not applicable (e.g., tests).
 */
export async function runRequestGuard(): Promise<void> {
  await rateLimiter.acquire(authStore.rateLimitSeconds, authStore.rateLimitWait)

  if (authStore.manualApprove) {
    await awaitApproval()
  }
}
