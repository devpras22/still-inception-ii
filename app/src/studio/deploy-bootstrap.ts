/**
 * THE DEPLOYED DEMO BOOTSTRAP — judges press ▶ begin, nothing else.
 *
 * A studio clone serves people who configure their own keys in Settings. A
 * deployed link serves strangers who will configure nothing. This module is
 * the difference: before the app mounts, it asks the deployment's own
 * /api/config whether this IS a deployed build, and if so writes the provider
 * configuration the demo needs —
 *
 *   · the Reactor key, fetched at runtime from the server and held only in
 *     this browser's localStorage (Vercel env → /api/config → localStorage;
 *     nothing is baked into the bundle),
 *   · the hosted world store, pointed at this origin's /api so the STILL
 *     world record is served by the deployment itself,
 *   · the LLM through /api/llm, so the improvised homecoming lines cost the
 *     judge no key of their own,
 *   · the voice bridge at /api/voice, which holds the fish.audio key
 *     server-side.
 *
 * In a dev clone /api/config does not exist, the fetch fails fast, and none
 * of this runs — local Settings stay the single source of truth.
 */

/** The store key the provider registry reads at mount (see registry.ts). */
const PROVIDERS_KEY = 'alakazam-studio:providers:v1'

/** True once the bootstrap has talked to a deployment's /api/config — the
 *  app reads this to lock the experience into a cinema: no way back to the
 *  authoring studio, whose Settings would display the keys it installed. */
let deployedDemo = false
export function isDeployedDemo(): boolean { return deployedDemo }

interface DeployConfig {
  deployed: boolean
  reactorKey?: string
}

async function fetchDeployConfig(): Promise<DeployConfig | null> {
  try {
    const res = await fetch('/api/config', { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    const cfg = (await res.json()) as DeployConfig
    return cfg?.deployed ? cfg : null
  } catch {
    return null
  }
}

export async function bootstrapDeployedDemo(): Promise<void> {
  const cfg = await fetchDeployConfig()
  if (!cfg) return
  deployedDemo = true
  const reactorKey = (cfg.reactorKey ?? '').trim()
  if (!reactorKey) return // a deployment without its key configured stays a plain studio

  // THE DOMAIN IS THE FILM. A judge types the bare URL; the studio home it
  // would show is an authoring tool they were never meant to meet. On a
  // deployed build the root — and anything that is not already a deep link —
  // becomes the STILL play link before the first render.
  const params = new URLSearchParams(window.location.search)
  if (window.location.pathname === '/' && [...params.keys()].length === 0) {
    window.location.replace('/?play=w_mt5nh92neea951dd')
    return
  }

  localStorage.setItem(PROVIDERS_KEY, JSON.stringify({
    world: {
      // Reactor streams the world models straight from the browser; the key
      // arrives per-session from /api/config, never baked into the bundle.
      active: 'reactor',
      reactor: { apiKey: reactorKey, mode: 'adventure' },
      websocket: { url: '', apiKey: '', protocol: 'raw' },
      // A non-empty key selects the HOSTED store — here this origin's /api,
      // which serves the STILL record and doubles as the voice bridge base.
      alakazam: { apiBase: '/api', embedHost: '', apiKey: 'still-demo' },
    },
    llm: {
      active: 'openai',
      endpoints: {
        openai: { baseUrl: '/api/llm', apiKey: 'served', model: 'gpt-4o-mini' },
      },
    },
    image: { geminiKey: '', model: 'gemini-3-pro-image' },
    vision: { endpoint: 'local', apiKey: '', localUrl: '' },
  }))
}
