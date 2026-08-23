/**
 * Which store holds the worlds.
 *
 * One rule: an Alakazam key means hosted, no key means this browser. The key —
 * not `world.active`. The two axes are independent, and someone driving their
 * own Reactor endpoint while keeping their worlds on the hosted API is a normal
 * setup, not a contradiction. Reading `world.active` here would strand those
 * worlds behind a provider switch.
 *
 * The client is injected because the studio builds exactly one, with the onCall
 * hook that feeds the API log panel. A client is constructed here only as a
 * fallback for callers that have a key but no client — falling back to local
 * storage in that case would be far worse: the user's hosted worlds would appear
 * to have vanished, and anything they authored would land in a browser they were
 * not told about.
 */

import { AlakazamClient } from '../api'
import type { ProviderConfig } from '../../provider'
import { LocalWorldStore } from './local'
import { RemoteWorldStore } from './remote'
import type { WorldStore } from './types'

export { LocalWorldStore, type KeyValueStore } from './local'
export { RemoteWorldStore } from './remote'
export * from './types'

/** True when worlds will be read from and written to the hosted API. */
export function isHostedStorage(cfg: ProviderConfig): boolean {
  return cfg.world.alakazam.apiKey.trim().length > 0
}

// Stores are cheap, but rebuilding one on every render would churn the client
// reference the remote store closes over, so they are keyed like the providers
// in registry.ts: same inputs, same instance.
let cache: { key: string; client: AlakazamClient | undefined; store: WorldStore } | null = null

export function pickWorldStore(cfg: ProviderConfig, client?: AlakazamClient): WorldStore {
  const hosted = isHostedStorage(cfg)
  const key = hosted
    ? `remote|${cfg.world.alakazam.apiBase}|${cfg.world.alakazam.apiKey}`
    : 'local'

  if (cache && cache.key === key && cache.client === client) return cache.store

  const store: WorldStore = hosted
    ? new RemoteWorldStore(client ?? new AlakazamClient({ baseUrl: cfg.world.alakazam.apiBase, apiKey: cfg.world.alakazam.apiKey }))
    : new LocalWorldStore()

  cache = { key, client, store }
  return store
}

