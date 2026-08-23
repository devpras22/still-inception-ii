import { useEffect, useRef, useState } from 'react'
import { authoringInputFor, authoringLeafFor } from './agent/route'
import { useClient } from '../studio'
import { toApiFailure } from '../world'
import type { Diagnostic } from '../world'
import { getImageProvider, getLLMProvider, getVisionProvider } from '../provider'

/** Statuses that stop the poll loop. Anything else means "still working". */
const TERMINAL = new Set(['succeeded', 'failed', 'dead'])

export interface JobView { status: string; phase?: string | undefined; progress?: number }
export interface SeedView { b64: string; mime: string; url: string }
/** What author.generate hands back once it lands — see authorGraph below. */
export interface GeneratedView { reply: string; states: number; events: number }

/**
 * Eight short premises in the studio's voice, used for the TRY chips and the
 * idle-placeholder typewriter. Fixed and small on purpose: a pool that
 * changed shape between renders would make the chips and the placeholder
 * cycle disagree about what "premise 3" even is.
 */
export const PREMISE_POOL: readonly string[] = [
  'a beaver exploring Atlantis',
  'a courier wakes handcuffed in a moving train',
  'a lighthouse keeper on the night the lamp fails',
  'a locksmith robs the vault they used to guard',
  'a diner waitress serves the last customer before the world ends',
  'a submarine crew hears a knock from outside the hull',
  'an astronaut wakes up alone on a ship that should have a crew',
  'a forest ranger radios in a fire that is not spreading like fire',
]

/** Turn any thrown value into a human string, surfacing ApiError.status/detail/diagnostics. */
function errMsg(e: unknown): string {
  const f = toApiFailure(e)
  const n = f.diagnostics.length
  const diag = n ? ` · ${n} diagnostic${n === 1 ? '' : 's'}` : ''
  const code = f.status ? ` [${f.status}]` : ''
  return `${f.detail}${code}${diag}`
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Normalize a job progress (0..1 or 0..100) to an integer percent, or null if unknown. */
function toPct(p: number | undefined): number | null {
  if (typeof p !== 'number' || Number.isNaN(p)) return null
  const v = p <= 1 ? p * 100 : p
  return Math.max(0, Math.min(100, Math.round(v)))
}

/** Everything a chrome (page or floating) needs to render the create flow. Two
 *  variants share this one view model so the interaction core — premise, seed
 *  painting, world.create, the author.generate follow-up, the hosted job poll,
 *  and every honest failure/retry path — exists exactly once. */
export interface ComposerViewModel {
  canPaint: boolean
  /** Whether a grounded quest can be authored: needs a painter AND an eye. */
  canProbe: boolean
  quest: boolean
  setQuest: (on: boolean) => void
  isLocal: boolean
  llmLabel: string
  canGenerate: boolean

  premise: string
  setPremise: (v: string) => void
  trimmed: string
  asyncMode: boolean
  setAsyncMode: (v: boolean) => void

  seeding: boolean
  /** What the authoring pipeline says it is doing right now, in its own words —
   *  empty when nothing is running. */
  stage: string
  seed: SeedView | null
  previewSrc: string | null
  paintSeed: () => void
  clearSeed: () => void

  creating: boolean
  authoring: boolean
  working: boolean

  job: JobView | null
  pct: number | null
  succeeded: boolean

  generated: GeneratedView | null
  genDiagnostics: Diagnostic[]

  failedWorldId: string | null
  error: string | null

  startCreate: () => void
  startExample: (template?: 'starter' | 'quest') => void
  retry: () => void
  openFailed: () => void
}

/**
 * Create a new world from a premise. Optionally "paint a seed frame first"
 * (client.seedFrame) and hand that image to the generator as the opening frame.
 *
 * Two backends, two very different paths to a real graph:
 *   - Hosted store: async mode (default) polls client.getJob every 3s; sync mode
 *     blocks on the single POST /v1/worlds call (~a minute). Either way the
 *     hosted API authors the full graph server-side — nothing extra to do here.
 *   - Local store: world.create (see world/tools.ts) never calls a language
 *     model itself, on purpose — the same code runs identically from the CLI,
 *     which has none configured. So with one configured here (Settings →
 *     language model), this panel runs a second step, author.generate, right
 *     after creation to author the states/events/ending a premise implies.
 *     Without one it says so before the button is even pressed, rather than
 *     handing back a single state and letting the user find out by reading it.
 *
 * On success → onCreated(worldId). A failed author.generate never rolls the
 * world back — the opening state world.create wrote is real and stays real;
 * the failure is reported inline, next to a way to open that world anyway.
 *
 * `initialPremise` seeds the textarea on mount — the floating composer's dice
 * button fills a random premise and expands straight into a populated box
 * rather than an empty one the author has to re-fill.
 */
export function useComposer({ onCreated, initialPremise }: { onCreated: (worldId: string) => void; initialPremise?: string | undefined }): ComposerViewModel {
  const { client, store, tools, providers } = useClient()
  // Painting a seed frame needs an image model: either your own Gemini key,
  // or — failing that — the hosted seed-frame path when an Alakazam key is
  // configured. Creating a world needs neither — the store can make one
  // right here, which is the whole point of the offline path.
  const canPaint = getImageProvider(providers).isConfigured() || !!providers.world.alakazam.apiKey
  // A QUEST is grounded on what a detector really found in the frame, so it needs
  // an eye as well as a painter. Offering the mode without one would promise a
  // grounding the tool refuses to fake — the same rule `CHAPTER_MIN_CHARS`
  // enforces for length, one capability over.
  const canProbe = canPaint && getVisionProvider(providers).isConfigured()
  // Only the local store's premise path needs this: the hosted API authors the
  // full graph itself, with keys of its own this studio never sees.
  const isLocal = store.info.id === 'local'
  const llm = getLLMProvider(providers)
  const canGenerate = llm.isConfigured()

  const [premise, setPremise] = useState(initialPremise ?? '')
  /** Author a MISSION from a probed frame rather than a place to stand in. */
  const [quest, setQuest] = useState(false)
  const [asyncMode, setAsyncMode] = useState(true)

  const [seeding, setSeeding] = useState(false)
  const [seed, setSeed] = useState<SeedView | null>(null)

  const [creating, setCreating] = useState(false)
  const [authoring, setAuthoring] = useState(false)
  /** The pipeline's own words for what it is doing right now. */
  const [stage, setStage] = useState('')
  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<JobView | null>(null)
  const [generated, setGenerated] = useState<GeneratedView | null>(null)
  const [genDiagnostics, setGenDiagnostics] = useState<Diagnostic[]>([])
  // Set only when world.create succeeded and the FOLLOW-UP author.generate
  // failed — the world named here is real and un-discarded; it just still
  // holds only its opening state.
  const [failedWorldId, setFailedWorldId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Keep the latest onCreated without making it a poll-effect dependency.
  const onCreatedRef = useRef(onCreated)
  useEffect(() => { onCreatedRef.current = onCreated }, [onCreated])

  // Poll the job while a jobId is active. Reruns on jobId change; cleans up on unmount.
  useEffect(() => {
    if (!jobId) return
    let alive = true
    let timer: number | undefined
    const tick = async () => {
      try {
        const j = await client.getJob(jobId)
        if (!alive) return
        setJob({ status: j.status, ...(j.phase !== undefined ? { phase: j.phase } : {}), ...(j.progress !== undefined ? { progress: j.progress } : {}) })
        if (TERMINAL.has(j.status)) {
          setCreating(false)
          if (j.status === 'succeeded') {
            if (j.worldId) onCreatedRef.current(j.worldId)
            else setError('Build succeeded but returned no worldId.')
          } else {
            setError(j.error || `Build ${j.status}.`)
          }
          return
        }
        timer = window.setTimeout(tick, 3000)
      } catch (e) {
        if (!alive) return
        setCreating(false)
        setError(errMsg(e))
      }
    }
    void tick()
    return () => { alive = false; if (timer !== undefined) window.clearTimeout(timer) }
  }, [jobId, client])

  const trimmed = premise.trim()
  const working = creating || seeding

  async function paintSeed() {
    if (!trimmed) return
    setError(null)
    setSeeding(true)
    try {
      const imageProvider = getImageProvider(providers)
      if (imageProvider.isConfigured()) {
        const r = await imageProvider.generate(trimmed)
        setSeed({ b64: r.b64, mime: r.mime, url: '' })
      } else {
        const r = await client.seedFrame({ prompt: trimmed })
        setSeed({ b64: r.imageBase64, mime: r.mimeType || 'image/png', url: r.url })
      }
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setSeeding(false)
    }
  }

  function clearSeed() {
    setSeed(null)
  }

  /**
   * The example world — three states, two transitions, an override. It exists in
   * the store and is the best thing to open first, but nothing in the UI could
   * reach it: it needs `template: 'starter'` and every path here sent a premise.
   * So a new user's first world was a single empty state, and the one artifact
   * built to teach the graph was unreachable.
   *
   * Needs no premise, no LLM and no key, which is the point — it is what there is
   * to look at before you have configured anything.
   */
  async function startExample(template: 'starter' | 'quest' = 'starter') {
    if (working) return
    setError(null)
    setCreating(true)
    const res = await tools.run('world.create', { example: true, ...(template === 'quest' ? { template } : {}) })
    setCreating(false)
    if (res.ok) {
      const worldId = isRecord(res.value) && typeof res.value['worldId'] === 'string' ? res.value['worldId'] : undefined
      if (worldId) onCreatedRef.current(worldId)
      else setError('The example world was created but came back without an id.')
    } else {
      setError(res.error.message)
    }
  }

  /**
   * The second half of a local premise-create: `worldId` already exists, holding
   * just its opening state (world.create's honest "blank"). This runs
   * author.generate against it to write the rest of the graph. Whatever happens
   * next, that world is never re-created or torn down here — success opens the
   * editor on it, failure reports inline next to a way to open it anyway.
   */
  async function authorGraph(worldId: string) {
    setAuthoring(true)
    setStage('Authoring the world…')
    // WHAT YOU PASTED DECIDES, rather than a mode switch. `author chapter` shipped
    // as a CLI and agent leaf with no way for a person in the browser to reach
    // it — the same shape as the flag algebra having no editor, and a pattern
    // that kept recurring. A chapter is not a different
    // intention from a premise, it is more of one, so the length routes it:
    // below the threshold your text IS the premise, at or above it the text is
    // read as prose and the world follows its beats. `CHAPTER_MIN_CHARS` is the
    // same floor `runChapterToWorld` refuses under, so the UI cannot offer a
    // path the tool will reject.
    // The choice of leaf and the shape of its input belong to the author domain,
    // not to this composer: `route.ts` owns both, so the CLI, an agent and this
    // screen cannot disagree about what a quest or a chapter means.
    const leaf = authoringLeafFor(trimmed, { quest, canProbe })
    const res = await tools.run(
      leaf,
      authoringInputFor(leaf, worldId, trimmed),
      // The pipeline names its own steps as it runs them. Without this the
      // composer showed one sentence for the whole minute, so paint and probe
      // — the expensive, interesting half — were invisible, and a run that had
      // silently skipped the probe looked exactly like one that had not.
      { onProgress: (note) => setStage(note) },
    )
    setAuthoring(false)
    setStage('')
    setCreating(false)
    if (res.ok) {
      const v = res.value
      setGenerated({
        reply: isRecord(v) && typeof v['reply'] === 'string' ? v['reply'] : '',
        states: isRecord(v) && typeof v['states'] === 'number' ? v['states'] : 0,
        events: isRecord(v) && typeof v['events'] === 'number' ? v['events'] : 0,
      })
      setGenDiagnostics(res.diagnostics)
      onCreatedRef.current(worldId)
    } else {
      setFailedWorldId(worldId)
      setGenDiagnostics(res.error.diagnostics)
      setError(res.error.message)
    }
  }

  async function startCreate() {
    if (!trimmed || working) return
    setError(null)
    setJob(null)
    setJobId(null)
    setGenerated(null)
    setGenDiagnostics([])
    setFailedWorldId(null)
    setCreating(true)
    const res = await tools.run('world.create', {
      premise: trimmed,
      async: asyncMode,
      ...(seed ? { frame: seed.b64 } : {}),
    })
    if (!res.ok) {
      setCreating(false)
      setError(res.error.message)
      return
    }
    const worldId = isRecord(res.value) && typeof res.value['worldId'] === 'string' ? res.value['worldId'] : undefined
    const returnedJobId = isRecord(res.value) && typeof res.value['jobId'] === 'string' ? res.value['jobId'] : undefined
    const status = isRecord(res.value) && typeof res.value['status'] === 'string' ? res.value['status'] : undefined
    // Whether we asked for async or not, the server may answer either way:
    // prefer an immediate worldId; else fall back to polling the jobId.
    if (worldId) {
      if (isLocal && canGenerate) {
        await authorGraph(worldId)
      } else {
        setCreating(false)
        onCreatedRef.current(worldId)
      }
    } else if (returnedJobId) {
      setJob({ status: status || 'queued' })
      setJobId(returnedJobId)
    } else {
      setCreating(false)
      setError('Create returned neither a worldId nor a jobId.')
    }
  }

  /**
   * "Try again" after a failure. When the world already exists and only
   * authoring it failed, retrying re-runs author.generate on that SAME world —
   * clicking retry twice must not leave two half-authored worlds behind.
   * Otherwise (world.create itself never succeeded) there is nothing yet to
   * author against, so this is a full restart.
   */
  async function retry() {
    if (failedWorldId) {
      setError(null)
      setCreating(true)
      await authorGraph(failedWorldId)
    } else {
      await startCreate()
    }
  }

  /** Open the world a failed author.generate left behind, as-is. */
  function openFailed() {
    if (failedWorldId) onCreatedRef.current(failedWorldId)
  }

  const pct = job ? toPct(job.progress) : null
  const succeeded = job?.status === 'succeeded'
  const previewSrc = seed ? (seed.b64 ? `data:${seed.mime};base64,${seed.b64}` : seed.url) : null

  return {
    canPaint,
    canProbe,
    quest,
    setQuest,
    isLocal,
    llmLabel: llm.label,
    canGenerate,
    premise,
    setPremise,
    trimmed,
    asyncMode,
    setAsyncMode,
    seeding,
    stage,
    seed,
    previewSrc,
    paintSeed: () => { void paintSeed() },
    clearSeed,
    creating,
    authoring,
    working,
    job,
    pct,
    succeeded,
    generated,
    genDiagnostics,
    failedWorldId,
    error,
    startCreate: () => { void startCreate() },
    startExample: (template) => { void startExample(template) },
    retry: () => { void retry() },
    openFailed,
  }
}
