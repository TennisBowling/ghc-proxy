import { GitHubClient } from '~/clients'
import { getClientConfig } from '~/lib/state'
import { authStore } from '~/state'

/**
 * Core handler for retrieving usage data.
 */
export async function handleUsageCore(): Promise<object> {
  const githubClient = new GitHubClient(authStore, getClientConfig())
  return await githubClient.getCopilotUsage()
}
