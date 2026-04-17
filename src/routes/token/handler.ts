import { authStore } from '~/state'

/**
 * Core handler for retrieving the token.
 */
export function handleTokenCore(): object {
  return {
    token: authStore.copilotToken,
  }
}
