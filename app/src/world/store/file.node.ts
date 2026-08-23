/**
 * A file-backed KeyValueStore, so the studio's own world store runs outside a
 * browser without a second implementation of anything.
 *
 * `LocalWorldStore` already takes its persistence as an injected
 * `KeyValueStore` — three methods — which means the entire store (graph
 * operations, versions, validation, quota handling, the lot) is reusable as-is
 * from Node. This file supplies those three methods against a JSON file. There
 * is no CLI-specific copy of the store, and there must never be one: the moment
 * the terminal and the browser run different code, they start disagreeing about
 * what a world is, and the disagreement surfaces as data loss.
 *
 * Writes are atomic — written to a temporary file in the same directory and
 * renamed over the target — because the alternative is a truncated JSON file
 * where somebody's worlds used to be. `rename` within a directory is atomic on
 * POSIX and on Windows via ReplaceFile semantics.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { KeyValueStore } from './local'

/** Where worlds live when the CLI is driving. Override with STUDIO_HOME. */
export function defaultStorePath(env: Record<string, string | undefined> = {}): string {
  const home = env['STUDIO_HOME']
  if (home !== undefined && home !== '') return join(home, 'worlds.json')
  return join(homedir(), '.alakazam-studio', 'worlds.json')
}

export function fileStore(path: string): KeyValueStore {
  let cache: Record<string, string> | null = null

  const load = (): Record<string, string> => {
    if (cache) return cache
    if (!existsSync(path)) {
      cache = {}
      return cache
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      // A hand-edited or truncated file must not take the process down: fall
      // back to empty and leave the original alone for the operator to inspect.
      cache = isStringRecord(parsed) ? parsed : {}
    } catch {
      cache = {}
    }
    return cache
  }

  const flush = (): void => {
    const data = cache ?? {}
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
    renameSync(tmp, path)
  }

  return {
    getItem(key) {
      const value = load()[key]
      return value === undefined ? null : value
    },
    setItem(key, value) {
      load()[key] = value
      flush()
    },
    removeItem(key) {
      const data = load()
      if (key in data) {
        delete data[key]
        flush()
      }
    },
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every((v) => typeof v === 'string')
}

