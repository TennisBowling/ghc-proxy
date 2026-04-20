#!/usr/bin/env bun

/**
 * Copilot tool support probe — tests all known tool types against every model.
 *
 * Outputs a deterministic JSON snapshot that can be diffed between weekly runs
 * to detect when Copilot adds or removes tool support.
 *
 * Usage:
 *   bun scripts/probe-all-copilot-tools.ts              # human-readable table
 *   bun scripts/probe-all-copilot-tools.ts --json        # JSON to stdout
 *   bun scripts/probe-all-copilot-tools.ts --model=claude-opus-4.6  # single model
 *
 * WARNING: Uses real Copilot quota — one request per (model × tool) pair.
 */

import type { Model } from '~/types'

import process from 'node:process'
import { copilotBaseUrl, copilotHeaders } from '~/lib/api-config'
import { MESSAGES_ENDPOINT, RESPONSES_ENDPOINT } from '~/lib/model-capabilities'
import { getClientConfig } from '~/lib/state'
import { authStore, modelCache } from '~/state'

import { bootstrapProbe, extractErrorMessage, runMain, tryParseJson } from './lib/probe-harness'

const REQUEST_TIMEOUT_MS = 60_000

// ── CLI args ──

const rawArgs = Bun.argv.slice(2)
const jsonMode = rawArgs.includes('--json')
const requestedModelId = rawArgs.find(a => a.startsWith('--model='))?.slice('--model='.length)

// ── Tool case definitions ──

interface ToolCase {
  name: string
  tools: unknown[]
}

const messagesToolCases: ToolCase[] = [
  // Control
  {
    name: 'standard_function_tool',
    tools: [{
      name: 'echo',
      description: 'Echo back',
      input_schema: { type: 'object', properties: { value: { type: 'string' } } },
    }],
  },
  // Type-based tools (from Copilot's supported tags list)
  {
    name: 'bash_20250124',
    tools: [{ type: 'bash_20250124', name: 'bash' }],
  },
  {
    name: 'text_editor_20250124',
    tools: [{ type: 'text_editor_20250124', name: 'str_replace_editor' }],
  },
  {
    name: 'text_editor_20250429',
    tools: [{ type: 'text_editor_20250429', name: 'str_replace_based_edit_tool' }],
  },
  {
    name: 'text_editor_20250728',
    tools: [{ type: 'text_editor_20250728', name: 'str_replace_based_edit_tool' }],
  },
  {
    name: 'web_search_20250305',
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
  },
  {
    name: 'memory_20250818',
    tools: [{ type: 'memory_20250818', name: 'memory' }],
  },
  {
    name: 'custom',
    tools: [{
      type: 'custom',
      name: 'my_custom_tool',
      description: 'A custom tool',
      input_schema: { type: 'object', properties: {} },
    }],
  },
  {
    name: 'tool_search_tool_bm25',
    tools: [{ type: 'tool_search_tool_bm25', name: 'tool_search_tool_bm25' }],
  },
  {
    name: 'tool_search_tool_bm25_20251119',
    tools: [{ type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' }],
  },
  {
    name: 'tool_search_tool_regex',
    tools: [{ type: 'tool_search_tool_regex', name: 'tool_search_tool_regex' }],
  },
  {
    name: 'tool_search_tool_regex_20251119',
    tools: [{ type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' }],
  },
  // Anthropic tools NOT in Copilot's tag list
  {
    name: 'code_execution_20250522',
    tools: [{ type: 'code_execution_20250522', name: 'code_execution' }],
  },
  {
    name: 'computer_20250124',
    tools: [{
      type: 'computer_20250124',
      name: 'computer',
      display_width_px: 1024,
      display_height_px: 768,
      display_number: 1,
    }],
  },
]

const responsesToolCases: ToolCase[] = [
  {
    name: 'function_tool',
    tools: [{
      type: 'function',
      name: 'echo',
      description: 'Echo back',
      parameters: { type: 'object', properties: { value: { type: 'string' } } },
    }],
  },
  { name: 'web_search_preview', tools: [{ type: 'web_search_preview' }] },
  { name: 'web_search_preview_2025_03_11', tools: [{ type: 'web_search_preview_2025_03_11' }] },
  { name: 'file_search', tools: [{ type: 'file_search' }] },
  { name: 'code_interpreter', tools: [{ type: 'code_interpreter' }] },
  {
    name: 'computer_use_preview',
    tools: [{ type: 'computer_use_preview', display_width: 1024, display_height: 768, environment: 'browser' }],
  },
  { name: 'image_generation', tools: [{ type: 'image_generation' }] },
  { name: 'custom_apply_patch', tools: [{ type: 'custom', name: 'apply_patch' }] },
  { name: 'custom_shell', tools: [{ type: 'custom', name: 'shell' }] },
  { name: 'mcp', tools: [{ type: 'mcp', server_label: 'test', headers: {} }] },
]

// ── Probe runner ──

interface ToolResult {
  status: 'supported' | 'rejected' | 'error'
  http: number
  error?: string
}

async function probeCase(
  baseUrl: string,
  headers: Record<string, string>,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    const payload = tryParseJson(await response.text())

    if (response.status >= 200 && response.status < 300)
      return { status: 'supported', http: response.status }

    return { status: 'rejected', http: response.status, error: extractErrorMessage(payload) }
  }
  catch (err) {
    return { status: 'error', http: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

function buildMessagesBody(modelId: string, tools: unknown[]) {
  return {
    model: modelId,
    max_tokens: 32,
    messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
    tools,
  }
}

function buildResponsesBody(modelId: string, tools: unknown[]) {
  return {
    model: modelId,
    input: [{ type: 'message', role: 'user', content: 'Reply with the single word OK.' }],
    max_output_tokens: 32,
    tools,
  }
}

// ── Model selection ──

function selectModels(models: Model[]) {
  const messagesModels = models.filter(m => m.supported_endpoints?.includes(MESSAGES_ENDPOINT))
  const responsesModels = models.filter(m => m.supported_endpoints?.includes(RESPONSES_ENDPOINT))

  if (requestedModelId) {
    return {
      messages: messagesModels.filter(m => m.id === requestedModelId),
      responses: responsesModels.filter(m => m.id === requestedModelId),
    }
  }

  return { messages: messagesModels, responses: responsesModels }
}

// ── Human-readable output ──

function printTable(
  endpoint: string,
  models: Model[],
  results: Map<string, Map<string, ToolResult>>,
) {
  if (models.length === 0) {
    process.stdout.write(`\n${endpoint}: no models available\n`)
    return
  }

  process.stdout.write(`\n── ${endpoint} ──\n\n`)

  for (const model of models) {
    const modelResults = results.get(model.id)
    if (!modelResults)
      continue

    process.stdout.write(`  ${model.id}\n`)

    for (const [toolName, result] of modelResults) {
      const pad = toolName.padEnd(38)
      if (result.status === 'supported') {
        process.stdout.write(`    ${pad} ✅ supported  (${result.http})\n`)
      }
      else if (result.status === 'rejected') {
        process.stdout.write(`    ${pad} ❌ rejected   (${result.http})\n`)
        process.stdout.write(`${''.padEnd(44)}→ ${result.error}\n`)
      }
      else {
        process.stdout.write(`    ${pad} ⚠️  error\n`)
        process.stdout.write(`${''.padEnd(44)}→ ${result.error}\n`)
      }
    }

    process.stdout.write('\n')
  }
}

// ── Main ──

async function runProbes(
  baseUrl: string,
  models: Model[],
  toolCases: ToolCase[],
  endpoint: string,
  buildBody: (modelId: string, tools: unknown[]) => Record<string, unknown>,
): Promise<Map<string, Map<string, ToolResult>>> {
  const results = new Map<string, Map<string, ToolResult>>()

  for (const model of models) {
    const modelMap = new Map<string, ToolResult>()
    if (!jsonMode)
      process.stdout.write(`\nProbing ${endpoint} × ${model.id} ...`)

    for (const tc of toolCases) {
      const headers = copilotHeaders(authStore, getClientConfig(), { initiator: 'agent' })
      const result = await probeCase(baseUrl, headers, endpoint, buildBody(model.id, tc.tools))
      modelMap.set(tc.name, result)
    }

    results.set(model.id, modelMap)
    if (!jsonMode)
      process.stdout.write(' done\n')
  }

  return results
}

function sortedMapKeys<V>(map: Map<string, V>): string[] {
  const arr: string[] = []
  map.forEach((_, k) => arr.push(k))
  arr.sort()
  return arr
}

function mapToSortedRecord(
  results: Map<string, Map<string, ToolResult>>,
): Record<string, Record<string, ToolResult>> {
  const out: Record<string, Record<string, ToolResult>> = {}

  for (const modelId of sortedMapKeys(results)) {
    const modelMap = results.get(modelId)!
    const tools: Record<string, ToolResult> = {}
    for (const name of sortedMapKeys(modelMap)) {
      const r = modelMap.get(name)!
      tools[name] = r.status === 'supported' ? { status: r.status, http: r.http } : r
    }
    out[modelId] = tools
  }

  return out
}

async function main() {
  await bootstrapProbe({ timeoutMs: REQUEST_TIMEOUT_MS })

  const allModels = modelCache.getModels()?.data ?? []
  const { messages: messagesModels, responses: responsesModels } = selectModels(allModels)
  const clientConfig = getClientConfig()
  const baseUrl = copilotBaseUrl(clientConfig)

  const totalProbes
    = messagesModels.length * messagesToolCases.length
      + responsesModels.length * responsesToolCases.length

  if (!jsonMode) {
    process.stdout.write('╔══════════════════════════════════════════════════════════════╗\n')
    process.stdout.write('║      Copilot Backend — Tool Support Probe                   ║\n')
    process.stdout.write('╚══════════════════════════════════════════════════════════════╝\n\n')
    process.stdout.write(`Models:  ${messagesModels.length} messages, ${responsesModels.length} responses\n`)
    process.stdout.write(`Probes:  ${totalProbes} total\n`)
  }

  const messagesResults = await runProbes(
    baseUrl,
    messagesModels,
    messagesToolCases,
    MESSAGES_ENDPOINT,
    buildMessagesBody,
  )
  const responsesResults = await runProbes(
    baseUrl,
    responsesModels,
    responsesToolCases,
    RESPONSES_ENDPOINT,
    buildResponsesBody,
  )

  if (jsonMode) {
    const output = {
      generatedAt: new Date().toISOString(),
      models: {
        messages: messagesModels.map(m => m.id).sort(),
        responses: responsesModels.map(m => m.id).sort(),
      },
      messages: mapToSortedRecord(messagesResults),
      responses: mapToSortedRecord(responsesResults),
    }

    await Bun.write(Bun.stdout, `${JSON.stringify(output, null, 2)}\n`)
  }
  else {
    printTable('/v1/messages', messagesModels, messagesResults)
    printTable('/responses', responsesModels, responsesResults)

    let supported = 0
    let rejected = 0
    let errors = 0
    for (const modelMap of [...messagesResults.values(), ...responsesResults.values()]) {
      for (const r of modelMap.values()) {
        if (r.status === 'supported')
          supported++
        else if (r.status === 'rejected')
          rejected++
        else errors++
      }
    }
    process.stdout.write(`── Summary: ${supported} supported, ${rejected} rejected, ${errors} errors (${totalProbes} total) ──\n`)
  }
}

runMain(main)
