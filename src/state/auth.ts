export class AuthStore {
  githubToken?: string
  copilotToken?: string
  copilotApiBase?: string
  gheDomain?: string
  accountType: 'individual' | 'business' | 'enterprise' = 'individual'
  manualApprove = false
  rateLimitSeconds?: number
  rateLimitWait = false
  showToken = false
  upstreamTimeoutSeconds?: number
}

export const authStore = new AuthStore()
