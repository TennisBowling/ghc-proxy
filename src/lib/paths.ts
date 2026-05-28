import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

function getAppDir(): string {
  return process.env.GHC_PROXY_APP_DIR
    || path.join(os.homedir(), '.local', 'share', 'ghc-proxy')
}

export const PATHS = {
  get APP_DIR() {
    return getAppDir()
  },
  get CONFIG_PATH() {
    return path.join(getAppDir(), 'config.json')
  },
}

export async function ensurePaths(): Promise<void> {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })
}
