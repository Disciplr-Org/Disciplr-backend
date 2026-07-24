import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const FLAG_FILE =
  process.env.WEBHOOK_PAUSE_FLAG_FILE ?? join(tmpdir(), 'disciplr_webhook_pause.flag')

export const isPaused = (): boolean => existsSync(FLAG_FILE)

export const pauseDelivery = (): void =>
  writeFileSync(FLAG_FILE, new Date().toISOString(), 'utf8')

export const resumeDelivery = (): void => {
  if (existsSync(FLAG_FILE)) unlinkSync(FLAG_FILE)
}

/** Exposed for tests to resolve the active flag path. */
export const getPauseFlagFile = (): string => FLAG_FILE
