import { colorize } from 'consola/utils'

export type ModelTransformTag
  = | 'AUTO_CORRECT'
    | 'CONFIG_REWRITE'
    | 'BETA_UPGRADE'
    | 'CONTEXT_UPGRADE'
    | 'COMPACT'
    | 'RETRY_UPGRADE'
    | 'MODEL_RESOLVE'

export interface ModelTransformStep {
  tag: ModelTransformTag
  result: string
}

export interface ModelMappingInfo {
  originalModel?: string
  steps: ModelTransformStep[]
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

export function getEffectiveModel(info: ModelMappingInfo): string {
  return info.steps.length > 0
    ? info.steps.at(-1)!.result
    : info.originalModel ?? '-'
}

export function appendModelStep(
  info: ModelMappingInfo,
  tag: ModelTransformTag,
  newModel: string,
): ModelMappingInfo {
  if (newModel === getEffectiveModel(info))
    return info
  return {
    originalModel: info.originalModel,
    steps: [...info.steps, { tag, result: newModel }],
  }
}

function formatModelMapping(info: ModelMappingInfo | undefined): string {
  if (!info)
    return ''

  const { originalModel, steps } = info
  if (!originalModel && steps.length === 0)
    return ''

  const display = originalModel ?? '-'
  const parts: string[] = [colorize('blueBright', display)]

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const isLast = i === steps.length - 1
    parts.push(colorize('dim', `-[${step.tag}]->`))
    parts.push(colorize(isLast ? 'greenBright' : 'cyanBright', step.result))
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
