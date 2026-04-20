import type { GetCopilotTokenResponse } from '~/types'

import consola from 'consola'

import { GitHubClient } from '~/clients'
import { authStore, modelCache } from '~/state'

import { getCachedConfig, writeConfigField } from './config'
import { HTTPError } from './error'
import { formatErrorMessage, retryWithBackoff } from './retry'
import { cacheVSCodeVersion, getClientConfig } from './state'

const TRAILING_SLASHES_RE = /\/+$/

async function writeGithubToken(token: string): Promise<void> {
  await writeConfigField('githubToken', token)
}

export async function setupCopilotToken() {
  await ensureVSCodeVersion()
  const githubClient = createGitHubClient()
  const response = await githubClient.getCopilotToken()
  applyCopilotTokenState(response)

  consola.debug('GitHub Copilot Token fetched successfully!')
  if (authStore.showToken) {
    consola.info('Copilot token:', response.token)
  }

  const REFRESH_BUFFER_SECONDS = 60
  const refreshInterval = (response.refresh_in - REFRESH_BUFFER_SECONDS) * 1000

  const scheduleRefresh = () => {
    setTimeout(() => {
      void refreshCopilotToken(githubClient).then(scheduleRefresh)
    }, refreshInterval)
  }
  scheduleRefresh()
}

export async function refreshCopilotToken(githubClient: GitHubClient): Promise<void> {
  consola.debug('Refreshing Copilot token')
  try {
    const refreshed = await retryWithBackoff(
      () => githubClient.getCopilotToken(),
      {
        shouldRetry: error => !(error instanceof HTTPError) || isTransientHttpError(error),
        onRetry: (error, attempt, delayMs) => {
          consola.warn(
            `Token refresh failed (attempt ${attempt + 1}), retrying in ${delayMs / 1000}s:`,
            formatErrorMessage(error),
          )
        },
      },
    )
    applyCopilotTokenState(refreshed)
    consola.debug('Copilot token refreshed')
    if (authStore.showToken) {
      consola.info('Refreshed Copilot token:', refreshed.token)
    }
  }
  catch (error) {
    consola.error('Failed to refresh Copilot token:', error)
  }
}

interface SetupGitHubTokenOptions {
  force?: boolean
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    await ensureVSCodeVersion()

    const cachedToken = getCachedConfig().githubToken
    const githubToken = cachedToken?.trim() || ''

    // Domain-change detection: if the configured GHE domain differs from
    // the previously persisted one, the cached token is for a different
    // GitHub instance and must not be reused.
    if (
      githubToken
      && !options?.force
      && isDomainChanged()
    ) {
      consola.warn(
        'GHE domain changed — cached token is for a different GitHub instance. Re-authenticating...',
      )
      await setupGitHubToken({ force: true })
      return
    }

    if (githubToken && !options?.force) {
      authStore.githubToken = githubToken
      if (authStore.showToken) {
        consola.info('GitHub token:', githubToken)
      }
      try {
        await logUser()
        return
      }
      catch (error) {
        if (isAuthError(error) && !options?.force) {
          consola.warn(
            'Stored GitHub token invalid or expired. Re-authenticating...',
          )
          await setupGitHubToken({ force: true })
          return
        }
        throw error
      }
    }

    consola.info('Not logged in, getting new access token')
    const githubClient = createGitHubClient()
    const response = await githubClient.getDeviceCode()
    consola.debug('Device code response:', response)

    consola.info(
      `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
    )

    const token = await githubClient.pollAccessToken(response)
    await writeGithubToken(token)
    authStore.githubToken = token

    // Persist the current GHE domain so future runs can detect domain changes.
    // Writing undefined removes the field from config (clears a previously-persisted domain).
    await writeConfigField('gheDomain', authStore.gheDomain)

    if (authStore.showToken) {
      consola.info('GitHub token:', token)
    }
    await logUser()
  }
  catch (error) {
    if (error instanceof HTTPError) {
      consola.error('Failed to get GitHub token:', error.body)
      throw error
    }

    consola.error('Failed to get GitHub token:', error)
    throw error
  }
}

function isAuthError(error: unknown) {
  return error instanceof HTTPError
    && (error.status === 401 || error.status === 403)
}

const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504])

function isTransientHttpError(error: HTTPError): boolean {
  return TRANSIENT_HTTP_STATUSES.has(error.status)
}

async function logUser() {
  const githubClient = createGitHubClient()
  const user = await githubClient.getGitHubUser()
  authStore.githubLogin = user.login
  consola.debug(`Logged in as ${user.login}`)
}

function createGitHubClient() {
  return new GitHubClient(authStore, getClientConfig())
}

function applyCopilotTokenState(response: GetCopilotTokenResponse) {
  authStore.copilotToken = response.token
  authStore.copilotApiBase = normalizeCopilotApiBase(response.endpoints?.api)
}

function normalizeCopilotApiBase(value?: string): string | undefined {
  if (!value) {
    return undefined
  }
  return value.replace(TRAILING_SLASHES_RE, '')
}

/**
 * Detects whether the runtime GHE domain differs from the previously persisted one.
 * Both `undefined` means "public github.com" → no change → returns false.
 */
function isDomainChanged(): boolean {
  const currentDomain = authStore.gheDomain
  const persistedDomain = getCachedConfig().gheDomain
  return currentDomain !== persistedDomain
}

async function ensureVSCodeVersion() {
  if (!modelCache.getVSCodeVersion()) {
    await cacheVSCodeVersion()
  }
}
