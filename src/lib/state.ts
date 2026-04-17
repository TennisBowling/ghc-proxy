import type { ResponsesEmulatorState } from './responses-emulator-state'
import type { UpstreamRequestQueueOptions } from './upstream-request-queue'
import type { ClientConfig } from '~/clients'

import type { ModelsResponse } from '~/types'

import consola from 'consola'
import { CopilotClient, getVSCodeVersion } from '~/clients'
import { buildGitHubUrls } from '~/lib/ghe-domain'
import { responsesEmulatorState } from './responses-emulator-state'
import { createDefaultUpstreamRequestQueue } from './upstream-request-queue'

export interface AuthState {
  githubToken?: string
  copilotToken?: string
  copilotApiBase?: string
  gheDomain?: string
}

export interface RuntimeConfig {
  accountType: 'individual' | 'business' | 'enterprise'
  manualApprove: boolean
  rateLimitSeconds?: number
  rateLimitWait: boolean
  showToken: boolean
  upstreamTimeoutSeconds?: number
  upstreamQueueConcurrency?: number
  upstreamQueueMaxRetries?: number
  upstreamQueueBaseDelaySeconds?: number
  upstreamQueueMaxDelaySeconds?: number
}

export interface CacheState {
  models?: ModelsResponse
  vsCodeVersion?: string
  githubLogin?: string
}

export interface RateLimitState {
  nextAvailableAt?: number
}

export interface AppState {
  auth: AuthState
  config: RuntimeConfig
  cache: CacheState
  rateLimit: RateLimitState
  responsesEmulator: ResponsesEmulatorState
}

export const state: AppState = {
  auth: {},
  config: {
    accountType: 'individual',
    manualApprove: false,
    rateLimitWait: false,
    showToken: false,
  },
  cache: {},
  rateLimit: {},
  responsesEmulator: responsesEmulatorState,
}

const upstreamRequestQueue = createDefaultUpstreamRequestQueue()

export function configureUpstreamRequestQueue(
  options: Partial<UpstreamRequestQueueOptions>,
): void {
  upstreamRequestQueue.updateOptions(options)
}

export function getClientConfig(): ClientConfig {
  const { baseUrl, apiBaseUrl } = buildGitHubUrls(state.auth.gheDomain)
  return {
    accountType: state.config.accountType,
    vsCodeVersion: state.cache.vsCodeVersion,
    copilotApiBase: state.auth.copilotApiBase,
    githubBaseUrl: baseUrl,
    githubApiBaseUrl: apiBaseUrl,
  }
}

export function createCopilotClient(): CopilotClient {
  return new CopilotClient(state.auth, getClientConfig(), {
    requestQueue: upstreamRequestQueue,
  })
}

export async function cacheModels(client?: CopilotClient): Promise<void> {
  const copilotClient = client ?? createCopilotClient()

  const models = await copilotClient.getModels()

  state.cache.models = models
}

export async function cacheVSCodeVersion() {
  const response = await getVSCodeVersion()
  state.cache.vsCodeVersion = response

  consola.debug(`Using VSCode version: ${response}`)
}
