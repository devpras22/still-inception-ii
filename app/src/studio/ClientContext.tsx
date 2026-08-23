import { createContext, useContext, useMemo, useState, useCallback, type ReactNode } from 'react'
import { AlakazamClient } from '../world'
import type { AppConfig } from './config'
import { getImageProvider, getLLMProvider, getVisionProvider } from '../provider'
import type { ProviderConfig } from '../provider'
import { pickWorldStore } from '../world'
import type { WorldStore } from '../world'
import { root, runTool } from '../tool'
import type { ToolOutcome } from '../tool'

/**
 * One row in the action log. Two shapes because the studio genuinely has two
 * layers: every action is a TOOL call dispatched in process, and when the store
 * is hosted, that tool call fans out into /v1 HTTP requests. Logging both makes
 * the layering visible — and makes the log honest on the keyless path, where
 * there are no HTTP calls at all and the old HTTP-only log sat empty forever
 * under a caption claiming everything showed up there.
 */
export type ActionLogEntry =
  | { id: number; via: 'http'; method: string; path: string; status: number; ms: number }
  | {
      id: number
      via: 'tool'
      path: string
      kind: 'query' | 'mutation' | 'unknown'
      ok: boolean
      /** Failure status when !ok; 0 on success (a tool call has no HTTP status of its own). */
      status: number
      ms: number
      origin: 'app' | 'agent'
    }

/** The app's door into the tool tree. Same tree, same validation as the CLI. */
export interface ToolBridge {
  /** Run one tool by dotted path with structured input. Never throws — the
   *  outcome envelope carries success and failure alike. */
  run(
    path: string,
    input: Record<string, unknown>,
    opts?: { origin?: 'app' | 'agent'; onProgress?: (note: string) => void },
  ): Promise<ToolOutcome>
}

interface Ctx {
  client: AlakazamClient
  config: AppConfig
  /** The whole provider picture — which world backend, which LLM, which store. */
  providers: ProviderConfig
  /**
   * Where worlds live. Hosted when an Alakazam key is configured, otherwise this
   * browser. Components talk to the store rather than the client so authoring
   * works before the user has an account with anyone.
   */
  store: WorldStore
  /**
   * The tool tree, in process. Panels route their MUTATIONS through this so
   * every write is the same declared, validated, logged operation the CLI runs;
   * reads stay direct on the store, whose richly-typed shapes the panels consume
   * structurally.
   */
  tools: ToolBridge
  embedHost: string
  log: ActionLogEntry[]
  clearLog: () => void
}

const ClientCtx = createContext<Ctx | null>(null)

export function useClient(): Ctx {
  const c = useContext(ClientCtx)
  if (!c) throw new Error('useClient must be used within <ClientProvider>')
  return c
}

let _seq = 0

export function ClientProvider({
  config,
  providers,
  children,
}: {
  config: AppConfig
  providers: ProviderConfig
  children: ReactNode
}) {
  const [log, setLog] = useState<ActionLogEntry[]>([])
  const clearLog = useCallback(() => setLog([]), [])

  // One client per (base,key). onCall streams every request into the live log.
  const client = useMemo(() => {
    const c = new AlakazamClient({ baseUrl: config.apiBase, apiKey: config.apiKey })
    c.onCall = (e) => setLog((prev) => [...prev.slice(-199), { id: ++_seq, via: 'http', ...e }])
    return c
  }, [config.apiBase, config.apiKey])

  // Re-picked whenever the alakazam slice changes, because that is what decides
  // hosted-vs-local. The client is passed in so hosted calls still land in the
  // API log the user is watching.
  const store = useMemo(() => pickWorldStore(providers, client), [providers, client])

  // The bridge closes over the memoized store and the log sink, so every tool
  // call — the app's own and the agent's — lands in the log the user is
  // watching, with the origin that made it.
  const tools = useMemo<ToolBridge>(
    () => ({
      run: async (path, input, opts) => {
        const origin = opts?.origin ?? 'app'
        // The app is the surface that HAS a language model, so it injects one —
        // the same seam shape as the CLI's readTextFile. A leaf that needs a
        // model (author.generate) gets the configured one; in the terminal it
        // is absent and that leaf says so rather than guessing.
        const llm = getLLMProvider(providers)
        const image = getImageProvider(providers)
        const vision = getVisionProvider(providers)
        const outcome = await runTool(
          root,
          path,
          input,
          {
            store,
            origin,
            json: false,
            ...(llm.isConfigured() ? { llm } : {}),
            ...(image.isConfigured() ? { image } : {}),
            ...(vision.isConfigured() ? { vision } : {}),
            // Per CALL, not per app: a stage line belongs to the surface that
            // asked for the work, so one panel's progress can never appear in
            // another's.
            ...(opts?.onProgress ? { progress: opts.onProgress } : {}),
          },
          () => performance.now(),
        )
        setLog((prev) => [
          ...prev.slice(-199),
          {
            id: ++_seq,
            via: 'tool',
            path: outcome.path,
            kind: outcome.kind,
            ok: outcome.ok,
            status: outcome.ok ? 0 : outcome.error.status,
            ms: Math.round(outcome.ms),
            origin,
          },
        ])
        return outcome
      },
    }),
    [store, providers],
  )

  const value = useMemo<Ctx>(
    () => ({ client, config, providers, store, tools, embedHost: config.embedHost, log, clearLog }),
    [client, config, providers, store, tools, log, clearLog],
  )

  // Dev-only verification seam. Headless runs need to author worlds in shapes no
  // UI path reaches yet — an entrance carrying a seed frame, for one — and the
  // alternative is hand-writing the store's private localStorage layout into a
  // test, which is a test that breaks the next time the schema moves. Guarded by
  // DEV, so it is absent from every production build.
  if (import.meta.env.DEV) {
    Object.assign(window, { __studio: { store, providers } })
  }
  return <ClientCtx.Provider value={value}>{children}</ClientCtx.Provider>
}
