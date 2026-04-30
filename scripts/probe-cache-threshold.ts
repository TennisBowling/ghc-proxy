#!/usr/bin/env bun

/**
 * Probe cache threshold for a specific model by sending requests with
 * increasing system prompt sizes.
 *
 * Usage:
 *   bun scripts/probe-cache-threshold.ts --model=claude-opus-4.7-xhigh
 *   bun scripts/probe-cache-threshold.ts --model=claude-opus-4.7-xhigh --sizes=1024,4096,8192,16384,32768
 */

import process from 'node:process'
import { copilotBaseUrl, copilotHeaders } from '~/lib/api-config'
import { MESSAGES_ENDPOINT } from '~/lib/model-capabilities'
import { getClientConfig } from '~/lib/state'
import { authStore, modelCache } from '~/state'

import { bootstrapProbe, runMain, tryParseJson } from './lib/probe-harness'

const REQUEST_TIMEOUT_MS = 120_000
const REPEAT_DELAY_MS = 1000

const rawArgs = Bun.argv.slice(2)
const modelId = rawArgs.find(a => a.startsWith('--model='))?.slice('--model='.length) ?? 'claude-opus-4.7-xhigh'
const customSizes = rawArgs.find(a => a.startsWith('--sizes='))?.slice('--sizes='.length)

const DEFAULT_SIZES = [1024, 4096, 8192, 16384, 32768, 65536]
const sizes = customSizes ? customSizes.split(',').map(Number) : DEFAULT_SIZES

interface CacheProbeResult {
  approxTokens: number
  promptChars: number
  primeStatus: number
  primeCached: number
  primeInput: number
  repeatStatus: number
  repeatCached: number
  repeatInput: number
  cacheHit: boolean
  error?: string
}

function generatePadding(charCount: number): string {
  const base = 'The quick brown fox jumps over the lazy dog. '
  const repeats = Math.ceil(charCount / base.length)
  return base.repeat(repeats).slice(0, charCount)
}

async function sendRawRequest(body: Record<string, unknown>): Promise<{
  httpStatus: number
  inputTokens: number
  cachedTokens: number
  error?: string
}> {
  try {
    const clientConfig = getClientConfig()
    const url = `${copilotBaseUrl(clientConfig)}${MESSAGES_ENDPOINT}`
    const headers = copilotHeaders(authStore, clientConfig, { initiator: 'agent' })

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    const text = await response.text()
    const parsed = tryParseJson(text) as Record<string, unknown> | null

    if (response.status < 200 || response.status >= 300) {
      const errMsg = (parsed as { error?: { message?: string } })?.error?.message
      return { httpStatus: response.status, inputTokens: 0, cachedTokens: 0, error: errMsg ?? `HTTP ${response.status}` }
    }

    const usage = parsed?.usage as { input_tokens?: number, cache_read_input_tokens?: number } | undefined
    return {
      httpStatus: response.status,
      inputTokens: usage?.input_tokens ?? 0,
      cachedTokens: usage?.cache_read_input_tokens ?? 0,
    }
  }
  catch (error) {
    return { httpStatus: 0, inputTokens: 0, cachedTokens: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

async function probeSize(approxTokens: number): Promise<CacheProbeResult> {
  // ~4 chars per token is a rough estimate
  const charCount = approxTokens * 4
  const padding = generatePadding(charCount)

  const body = {
    model: modelId,
    max_tokens: 16,
    system: [
      {
        type: 'text',
        text: `You are a helpful assistant. ${padding}`,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      { role: 'user', content: 'Say OK' },
    ],
  }

  process.stdout.write(`  ~${approxTokens} tokens (${charCount} chars)... `)

  const prime = await sendRawRequest(body)
  if (prime.error) {
    process.stdout.write(`ERROR: ${prime.error}\n`)
    return {
      approxTokens,
      promptChars: charCount,
      primeStatus: prime.httpStatus,
      primeCached: 0,
      primeInput: 0,
      repeatStatus: 0,
      repeatCached: 0,
      repeatInput: 0,
      cacheHit: false,
      error: prime.error,
    }
  }

  await Bun.sleep(REPEAT_DELAY_MS)

  const repeat = await sendRawRequest(body)

  const cacheHit = repeat.cachedTokens > 0
  process.stdout.write(
    cacheHit
      ? `HIT (cached=${repeat.cachedTokens}, input=${repeat.inputTokens})\n`
      : `MISS (cached=${repeat.cachedTokens}, input=${repeat.inputTokens})\n`,
  )

  return {
    approxTokens,
    promptChars: charCount,
    primeStatus: prime.httpStatus,
    primeCached: prime.cachedTokens,
    primeInput: prime.inputTokens,
    repeatStatus: repeat.httpStatus,
    repeatCached: repeat.cachedTokens,
    repeatInput: repeat.inputTokens,
    cacheHit,
  }
}

async function main() {
  await bootstrapProbe({ timeoutMs: REQUEST_TIMEOUT_MS })

  const model = modelCache.findById(modelId)
  if (!model) {
    process.stderr.write(`Model ${modelId} not found in Copilot model list.\n`)
    process.stderr.write(`Available: ${modelCache.getModelIds().join(', ')}\n`)
    process.exit(1)
  }

  process.stdout.write(`\n=== Cache threshold probe: ${modelId} ===\n`)
  process.stdout.write(`Endpoints: ${model.supported_endpoints?.join(', ') ?? 'none'}\n`)
  process.stdout.write(`Testing sizes: ${sizes.join(', ')} (approx tokens)\n\n`)

  const results: CacheProbeResult[] = []

  for (const size of sizes) {
    const result = await probeSize(size)
    results.push(result)

    if (result.error)
      continue
  }

  process.stdout.write(`\n=== Summary ===\n`)
  process.stdout.write(`Model: ${modelId}\n`)

  const firstHit = results.find(r => r.cacheHit)
  if (firstHit) {
    process.stdout.write(`Cache threshold: ~${firstHit.approxTokens} tokens (${firstHit.promptChars} chars)\n`)
    process.stdout.write(`First cache hit: cached=${firstHit.repeatCached} tokens\n`)
  }
  else {
    process.stdout.write(`No cache hits observed at any size (max tested: ~${sizes.at(-1)} tokens)\n`)
  }

  process.stdout.write(`\nDetailed results:\n`)
  for (const r of results) {
    const status = r.error ? `ERR(${r.error.slice(0, 60)})` : r.cacheHit ? 'HIT' : 'MISS'
    process.stdout.write(`  ~${String(r.approxTokens).padStart(6)} tokens: ${status.padEnd(8)} prime(in=${r.primeInput},cache=${r.primeCached}) repeat(in=${r.repeatInput},cache=${r.repeatCached})\n`)
  }
}

runMain(main)
