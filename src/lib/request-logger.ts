import { colorize } from 'consola/utils'

export interface ModelMappingInfo {
  originalModel?: string
  rewrittenModel?: string
  mappedModel?: string
}

/**
 * Per-request model mapping store.
 * Route handlers write to this; the after-response hook reads from it.
 * Uses WeakMap so entries are GC'd when the Request is collected.
 */
const requestModelMapping = new WeakMap<Request, ModelMappingInfo>()

export function setRequestModelMapping(request: Request, info: ModelMappingInfo): void {
  requestModelMapping.set(request, info)
}

export function getRequestModelMapping(request: Request): ModelMappingInfo | undefined {
  return requestModelMapping.get(request)
}

export function formatElapsed(start: number) {
  const delta = Date.now() - start
  return delta < 1000 ? `${delta}ms` : `${Math.round(delta / 1000)}s`
}

function formatPath(rawUrl: string) {
  try {
    const url = new URL(rawUrl)
    return `${url.pathname}${url.search}`
  }
  catch {
    return rawUrl
  }
}

function colorizeStatus(status: number): string {
  if (status >= 500)
    return colorize('red', status)
  if (status >= 400)
    return colorize('yellow', status)
  if (status >= 300)
    return colorize('cyan', status)
  return colorize('green', status)
}

const methodColors: Record<string, Parameters<typeof colorize>[0]> = {
  GET: 'cyan',
  POST: 'magenta',
  PUT: 'yellow',
  PATCH: 'yellow',
  DELETE: 'red',
}

function colorizeMethod(method: string): string {
  return colorize(methodColors[method] ?? 'white', method)
}

function formatModelMapping(info: ModelMappingInfo | undefined): string {
  if (!info)
    return ''

  const { originalModel, rewrittenModel, mappedModel } = info
  if (!originalModel && !rewrittenModel && !mappedModel)
    return ''

  const parts: string[] = []

  // Start with original model
  const displayOriginal = originalModel ?? '-'
  parts.push(colorize('blueBright', displayOriginal))

  // Rewrite arrow (~>)
  if (rewrittenModel && rewrittenModel !== displayOriginal) {
    parts.push(colorize('dim', '~>'))
    parts.push(colorize('cyanBright', rewrittenModel))
  }

  // Routing arrow (→) — compare against rewritten (if present) or original
  const effectiveModel = rewrittenModel ?? displayOriginal
  if (mappedModel && mappedModel !== effectiveModel) {
    parts.push(colorize('dim', '→'))
    parts.push(colorize('greenBright', mappedModel))
  }

  return ` ${colorize('dim', 'model=')}${parts.join(' ')}`
}

/**
 * Request logging function.
 * Logs a formatted request line with method, path, status, elapsed time,
 * and optional model mapping info.
 */
export function logRequest(
  method: string,
  url: string,
  status: number,
  elapsed: string,
  modelInfo?: ModelMappingInfo,
): void {
  const path = formatPath(url)
  const line = [
    colorize('dim', '<-'),
    colorizeMethod(method),
    colorize('white', path),
    colorizeStatus(status),
    colorize('dim', elapsed),
  ].join(' ')

  // eslint-disable-next-line no-console
  console.log(`${line}${formatModelMapping(modelInfo)}`)
}
