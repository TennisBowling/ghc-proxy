import type { ChatCompletionsPayload, ContentPart, FilePart, Model } from '~/types'

import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { throwInvalidRequestError } from '~/lib/error'
import { modelCache, RESPONSES_ENDPOINT } from '~/state'

const execFileAsync = promisify(execFile)
const PDF_DATA_URL_RE = /^data:application\/pdf;base64,(.+)$/s
const HTTP_URL_RE = /^https?:\/\//i
const RENDERED_PAGE_RE = /^page-\d+\.png$/
const MAX_BUFFER_BYTES = 50 * 1024 * 1024
const RENDER_DPI = 100

interface ProcessedPdf {
  text: string
  pageImageUrls: Array<string>
}

let cacheRootPromise: Promise<string> | undefined
const processedCache = new Map<string, Promise<ProcessedPdf>>()

function hasFileParts(payload: ChatCompletionsPayload): boolean {
  return payload.messages.some(
    message => Array.isArray(message.content)
      && message.content.some(part => part.type === 'file'),
  )
}

function shouldPreprocessPdfFiles(model: Model | undefined, payload: ChatCompletionsPayload): boolean {
  if (!hasFileParts(payload)) {
    return false
  }
  return !modelCache.supportsEndpoint(model, RESPONSES_ENDPOINT)
}

async function getCacheRoot(): Promise<string> {
  cacheRootPromise ??= mkdtemp(join(tmpdir(), 'ghc-proxy-pdf-cache-'))
  return cacheRootPromise
}

export async function cleanupPdfCache(): Promise<void> {
  if (!cacheRootPromise) {
    return
  }
  const cacheRoot = await cacheRootPromise.catch(() => undefined)
  if (cacheRoot) {
    await rm(cacheRoot, { recursive: true, force: true })
  }
  processedCache.clear()
  cacheRootPromise = undefined
}

async function readPdfBytes(part: FilePart): Promise<Buffer> {
  const data = part.file.file_data
  if (!data) {
    throwInvalidRequestError('file content requires file_data for PDF preprocessing.', 'messages', 'unsupported_file_content')
  }

  if (HTTP_URL_RE.test(data)) {
    const response = await fetch(data)
    if (!response.ok) {
      throwInvalidRequestError(`Failed to fetch PDF file: ${response.status} ${response.statusText}`, 'messages', 'file_fetch_failed')
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType && !contentType.toLowerCase().includes('pdf')) {
      throwInvalidRequestError('file URL did not return a PDF content type.', 'messages', 'unsupported_file_content')
    }
    return Buffer.from(await response.arrayBuffer())
  }

  const match = data.match(PDF_DATA_URL_RE)
  if (match) {
    return Buffer.from(match[1], 'base64')
  }

  return Buffer.from(data, 'base64')
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function renderPdf(bytes: Buffer, filename: string | undefined): Promise<ProcessedPdf> {
  const hash = hashBytes(bytes)
  const cached = processedCache.get(hash)
  if (cached) {
    return cached
  }

  const promise = processPdf(hash, bytes, filename)
  processedCache.set(hash, promise)
  return promise
}

async function processPdf(hash: string, bytes: Buffer, filename: string | undefined): Promise<ProcessedPdf> {
  const root = await getCacheRoot()
  const dir = join(root, hash)
  await mkdir(dir, { recursive: true })

  const pdfPath = join(dir, filename?.endsWith('.pdf') ? filename : 'document.pdf')
  const textPath = join(dir, 'document.txt')
  const imagePrefix = join(dir, 'page')
  await writeFile(pdfPath, bytes)

  let text = ''
  try {
    await execFileAsync('pdftotext', ['-layout', pdfPath, textPath], { maxBuffer: MAX_BUFFER_BYTES })
    text = await readFile(textPath, 'utf8')
  }
  catch {
    text = ''
  }

  let imagePaths: Array<string> = []
  try {
    await execFileAsync('pdftoppm', ['-png', '-r', String(RENDER_DPI), pdfPath, imagePrefix], { maxBuffer: MAX_BUFFER_BYTES })
    imagePaths = (await readdir(dir))
      .filter(file => RENDERED_PAGE_RE.test(file))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
      .map(file => join(dir, file))
  }
  catch (error) {
    if (!text.trim()) {
      const message = error instanceof Error ? error.message : String(error)
      throwInvalidRequestError(`Failed to render PDF pages: ${message}`, 'messages', 'pdf_preprocess_failed')
    }
  }

  const pageImageUrls = await Promise.all(imagePaths.map(async (path) => {
    const image = await readFile(path)
    return `data:image/png;base64,${image.toString('base64')}`
  }))

  return { text, pageImageUrls }
}

async function filePartToContentParts(part: FilePart): Promise<Array<ContentPart>> {
  const bytes = await readPdfBytes(part)
  if (bytes.length === 0 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throwInvalidRequestError('Only PDF file content is supported for chat-completions file preprocessing.', 'messages', 'unsupported_file_content')
  }

  const processed = await renderPdf(bytes, part.file.filename)
  const parts: Array<ContentPart> = []
  const name = part.file.filename ?? 'document.pdf'

  if (processed.text.trim()) {
    parts.push({
      type: 'text',
      text: `PDF attachment (${name}) extracted text:\n\n${processed.text.trim()}`,
    })
  }

  if (processed.pageImageUrls.length > 0) {
    parts.push({
      type: 'text',
      text: `PDF attachment (${name}) rendered page images follow (${processed.pageImageUrls.length} page${processed.pageImageUrls.length === 1 ? '' : 's'}).`,
    })
    for (const url of processed.pageImageUrls) {
      parts.push({ type: 'image_url', image_url: { url } })
    }
  }

  if (parts.length === 0) {
    throwInvalidRequestError('PDF preprocessing produced no text or page images.', 'messages', 'pdf_preprocess_failed')
  }

  return parts
}

export async function preprocessPdfFilePartsForChat(
  payload: ChatCompletionsPayload,
  model: Model | undefined,
): Promise<void> {
  if (!shouldPreprocessPdfFiles(model, payload)) {
    return
  }

  for (const message of payload.messages) {
    if (!Array.isArray(message.content)) {
      continue
    }

    const content: Array<ContentPart> = []
    for (const part of message.content) {
      if (part.type === 'file') {
        content.push(...await filePartToContentParts(part))
      }
      else {
        content.push(part)
      }
    }
    message.content = content
  }
}
