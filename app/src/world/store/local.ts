/**
 * LocalWorldStore — worlds that belong to the person who authored them.
 *
 * Everything here happens in one browser profile: no key, no account, no
 * network. That is the point. It is also the danger, and most of the length of
 * this file is spent on it. A hosted store loses your work only if a company
 * loses it; this one loses your work if a write silently half-succeeds, if a
 * quota error is swallowed, or if a corrupt blob is "recovered" by overwriting
 * it. So:
 *
 *   · Every mutation is read-modify-write of the WHOLE database, and the write
 *     is the last thing that happens. If any step throws, the parsed copy is
 *     discarded unwritten and storage still holds the last good state. That is
 *     the transaction, and it is why applyOps can be all-or-nothing without a
 *     rollback path that would itself need testing.
 *   · Nothing is cached between calls. Reading fresh costs a JSON.parse and buys
 *     correctness when a second tab is open, which is a thing people do.
 *   · A blob that will not parse is moved aside, never overwritten. If it cannot
 *     even be copied aside, the read fails loudly rather than starting empty on
 *     top of someone's worlds.
 *   · QuotaExceededError is reported as a 507 that names the biggest worlds and
 *     their snapshot counts, because "storage full" with no object is a dead end
 *     for the person holding the mouse.
 *
 * Optimistic concurrency is real, not decorative. Each world carries a counter
 * that increases on every graph write and never repeats; `rev` is its decimal
 * form. A write carrying a stale `ifMatch` is refused with 409 — the same status
 * and the same shape the components already handle — so the editor's "reload &
 * retry" path is exercised offline exactly as it is against the hosted API.
 *
 * validate() and lint() DO run here, against the local doctrine (../doctrine):
 * the graph-shape and text-register rules, which need no hosted kernel. The
 * lints that genuinely need a rendered frame stay absent from the catalogue
 * rather than reported as passing.
 */

import { diag, PROMPT_BUDGET, runDoctrine } from '../doctrine'
import type { Campaign, CampaignDiagnostic } from '../campaign'
import { PUBLIC_OPS } from '../api'
import type { SMDrive, SMPromptVariant, SMSequenceBeat } from '../api'
import { campaignHasErrors, lintCampaign as runCampaignLints } from '../campaign'
import { compileMission } from '../mission'
import { unwrapWorldDoc } from './types'
import type { NullablePatch } from './types'
import type {
  Diagnostic,
  GraphWriteResult,
  PublicOp,
  SMEvent,
  SMObjective,
  SMMission,
  SMScene,
  SMState,
  SMWorld,
  VersionNode,
  WorldList,
  WorldListItem,
} from '../types'
import {
  LOCAL_SCHEMA_VERSION,
  StoreError,
  type AddEventBody,
  type AddStateBody,
  type CreateWorldBody,
  type CreateWorldResult,
  type EntranceBody,
  type ExportedWorld,
  type ImportOptions,
  type ImportResult,
  type JobStatus,
  type ListParams,
  type LintResult,
  type SceneResult,
  type SnapshotBody,
  type StorageUsage,
  type ValidateResult,
  type VersionDiff,
  type WorldDocument,
  type WorldPatch,
  type WorldsExport,
  type WorldStore,
  type WorldStoreInfo,
  type WorldUsage,
} from './types'

/** The one key everything lives under. Bumping the suffix orphans old data. */
const DB_KEY = 'alakazam-studio:worlds:v1'
const DB_VERSION = 1

/**
 * Browsers do not agree on the localStorage ceiling or even on what unit they
 * count. 5 MiB is the common floor and is used only to phrase warnings; the
 * authority on whether a write fits is the write throwing.
 */
const ASSUMED_QUOTA_BYTES = 5 * 1024 * 1024

/** Enough replay protection for a double-clicked Create button. */
const IDEMPOTENCY_MEMORY = 32

const DEFAULT_LIST_PAGE = 24

// ─── What is on disk ─────────────────────────────────────────────────────────

interface StoredVersion {
  id: string
  parentVersionId: string | null
  source: string
  title: string | null
  created_at: string
  snapshot: SMWorld
}

interface StoredWorld {
  id: string
  name: string
  description: string
  cover: string | null
  visibility: string
  slug: string | null
  created_at: string
  updated_at: string
  /** Monotonic write counter. Never reused, never decreases — `rev` is String(rev). */
  rev: number
  /** The version the working graph was last snapshotted from or checked out to. */
  headVersionId: string | null
  world: SMWorld
  versions: StoredVersion[]
}

interface Db {
  version: number
  worlds: StoredWorld[]
  idem: { key: string; worldId: string }[]
  /** Multi-world stories. A campaign is a macro-graph over worlds that already
   *  live in `worlds` — it never holds a copy of one, so editing an act edits
   *  the campaign. Absent in every database written before campaigns existed,
   *  which `normalizeDb` treats as "none" rather than as corruption. */
  campaigns: Campaign[]
}

const emptyDb = (): Db => ({ version: DB_VERSION, worlds: [], idem: [], campaigns: [] })

// ─── Small tools ─────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

const isOptionalString = (v: unknown): v is string | undefined => v === undefined || typeof v === 'string'

const isNullableString = (v: unknown): v is string | null | undefined =>
  v === undefined || v === null || typeof v === 'string'

/** A `from`-shaped field: one state id, or several. */
const isStateRefs = (v: unknown): v is string | string[] => typeof v === 'string' || isStringArray(v)

const isLayerPair = (v: unknown): v is { static: string; dynamic: string } =>
  isRecord(v) && typeof v['static'] === 'string' && typeof v['dynamic'] === 'string'

const isEnding = (v: unknown): v is NonNullable<SMState['ending']> =>
  isRecord(v) &&
  (v['kind'] === 'win' || v['kind'] === 'lose') &&
  typeof v['title'] === 'string' &&
  (v['subtitle'] === undefined || typeof v['subtitle'] === 'string')

type EntranceImage = NonNullable<SMWorld['entrance']>['image']

/** Structural check for an entrance's optional cover image: `{src, label?}`. */
function readEntranceImage(raw: unknown): EntranceImage {
  if (!isRecord(raw) || typeof raw['src'] !== 'string') return undefined
  const label = typeof raw['label'] === 'string' ? raw['label'] : undefined
  return label !== undefined ? { label, src: raw['src'] } : { src: raw['src'] }
}

/**
 * A structural clone via JSON. Not a limitation: everything in this store round
 * trips through localStorage as JSON anyway, so dropping what JSON cannot carry
 * is the same thing persistence does.
 */
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

const now = (): string => new Date().toISOString()

const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null

/** UTF-8 length — what a person recognises as "the size of my data". */
function byteLen(s: string): number {
  return encoder ? encoder.encode(s).length : s.length
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function rid(prefix: string): string {
  const c = globalThis.crypto
  const tail = c && typeof c.randomUUID === 'function'
    ? c.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10)
  return `${prefix}_${Date.now().toString(36)}${tail}`
}

function slugify(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return out || 'world'
}


/**
 * JSON Merge Patch: a value replaces, `null` removes, `undefined` is not a
 * change. The removal case is the one that matters — without it there is no way
 * to clear a state's `ending` or an event's `anchor` once set.
 */
function mergePatch(target: object, patch: object): void {
  if (!isRecord(target)) return
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (v === null) delete target[k]
    else target[k] = v
  }
}

// ─── Reading untrusted stored data ───────────────────────────────────────────

function normalizeState(raw: unknown): SMState {
  const o = isRecord(raw) ? raw : {}
  const st: SMState = { ...o, base: str(o["base"]) }
  return st
}

function normalizeEvent(raw: unknown, index: number): SMEvent {
  const o = isRecord(raw) ? raw : {}
  const from = Array.isArray(o["from"])
    ? o["from"].filter((f): f is string => typeof f === 'string')
    : typeof o["from"] === 'string'
      ? [o["from"]]
      : []
  const kind = o["kind"] === 'override' || o["kind"] === 'terminal' ? o["kind"] : 'transition'
  return { ...o, name: str(o["name"]) || `event_${index + 1}`, kind, from }
}

function normalizeScene(raw: unknown): SMScene {
  const o = isRecord(raw) ? raw : {}
  const states: Record<string, SMState> = {}
  if (isRecord(o["states"])) {
    for (const [id, st] of Object.entries(o["states"])) states[id] = normalizeState(st)
  }
  const events = Array.isArray(o["events"]) ? o["events"].map(normalizeEvent) : []
  return { states, events }
}

/** Repairs rather than rejects: a half-written world is still someone's world. */
function normalizeWorld(raw: unknown, id: string): SMWorld {
  const o = isRecord(raw) ? raw : {}
  const world: SMWorld = { ...o, id, scene: normalizeScene(o["scene"]) }
  const entranceRaw = o["entrance"]
  if (isRecord(entranceRaw) && typeof entranceRaw["state"] === 'string') {
    const image = readEntranceImage(entranceRaw["image"])
    world.entrance = image ? { state: entranceRaw["state"], image } : { state: entranceRaw["state"] }
  } else {
    delete world.entrance
  }
  return world
}

function normalizeVersion(raw: unknown, worldId: string, index: number): StoredVersion {
  const o = isRecord(raw) ? raw : {}
  const id = str(o["id"]) || `v_recovered_${index + 1}`
  return {
    id,
    parentVersionId: typeof o["parentVersionId"] === 'string' ? o["parentVersionId"] : null,
    source: str(o["source"], 'snapshot'),
    title: typeof o["title"] === 'string' ? o["title"] : null,
    created_at: str(o["created_at"]) || now(),
    snapshot: normalizeWorld(o["snapshot"], worldId),
  }
}

function normalizeStoredWorld(raw: unknown, index: number): StoredWorld {
  const o = isRecord(raw) ? raw : {}
  // An entry with no id cannot be addressed, but it can be renamed. Dropping it
  // would be the data loss this file exists to prevent.
  const id = str(o["id"]) || rid('w')
  const created = str(o["created_at"]) || now()
  const rev = typeof o["rev"] === 'number' && Number.isFinite(o["rev"]) && o["rev"] >= 1 ? Math.floor(o["rev"]) : 1
  return {
    id,
    name: str(o["name"]) || `Untitled ${index + 1}`,
    description: str(o["description"]),
    cover: typeof o["cover"] === 'string' ? o["cover"] : null,
    visibility: str(o["visibility"], 'private'),
    slug: typeof o["slug"] === 'string' ? o["slug"] : null,
    created_at: created,
    updated_at: str(o["updated_at"]) || created,
    rev,
    headVersionId: typeof o["headVersionId"] === 'string' ? o["headVersionId"] : null,
    world: normalizeWorld(o["world"], id),
    versions: Array.isArray(o["versions"]) ? o["versions"].map((v, i) => normalizeVersion(v, id, i)) : [],
  }
}

function normalizeDb(raw: unknown): Db {
  const o = isRecord(raw) ? raw : {}
  return {
    version: typeof o["version"] === 'number' ? o["version"] : DB_VERSION,
    worlds: Array.isArray(o["worlds"]) ? o["worlds"].map(normalizeStoredWorld) : [],
    idem: Array.isArray(o["idem"])
      ? o["idem"]
          .filter(isRecord)
          .filter((e): e is Record<string, unknown> & { key: string; worldId: string } =>
            typeof e["key"] === 'string' && typeof e["worldId"] === 'string')
          .map((e) => ({ key: e.key, worldId: e.worldId }))
      : [],
    campaigns: Array.isArray(o["campaigns"]) ? o["campaigns"].filter(isCampaign) : [],
  }
}

/** A stored campaign, structurally. Anything that is not one is dropped rather
 *  than repaired: a half-understood macro-graph is worse than no campaign. */
function isCampaign(raw: unknown): raw is Campaign {
  if (!isRecord(raw)) return false
  const g = raw["graph"]
  if (!isRecord(g)) return false
  return (
    typeof raw["id"] === 'string' &&
    typeof raw["title"] === 'string' &&
    typeof g["start"] === 'string' &&
    Array.isArray(g["acts"]) &&
    Array.isArray(g["edges"]) &&
    Array.isArray(g["goldenThread"])
  )
}

// ─── The starter world ───────────────────────────────────────────────────────

/**
 * An original, deliberately small world: a lane, an orchard gate, a bench. Three
 * states, two transitions and one override, which is every mechanic the graph
 * editor can draw and the smallest thing that is still a complete world — it has
 * an entrance you arrive at and an ending you reach.
 *
 * Prompts describe what is in frame, not what it means. A world model paints
 * pixels; "peaceful" is not a pixel, "long shadows across the ruts" is.
 */
/** The shipped starter world, exposed for ONE consumer: the eDSL's acceptance
 *  oracle (`tests/unit/edsl.test.ts`), which re-authors it as a program and
 *  asserts the compiler reproduces it byte-for-byte. A language that cannot
 *  express the world you ship is not a language. */
export function starterSceneForTest(): SMScene {
  return starterWorld()
}

function starterWorld(): SMScene {
  return {
    states: {
      lane: {
        base: 'A narrow dirt lane between low stone walls, late afternoon. Deep ruts hold rainwater. Long shadows fall across the track from a line of poplars on the left.',
        camera: { static: 'eye level, walking height, lane centred', dynamic: 'slow forward drift' },
        movement: { static: 'standing still on the track', dynamic: 'grass heads moving at the wall base' },
        ambient: ['dust in low sun', 'a loose gate somewhere ahead'],
      },
      orchard_gate: {
        base: 'A wooden gate standing open in a gap in the stone wall. Beyond it, rows of old apple trees on unmown grass, fruit still on the branches.',
        camera: { static: 'eye level, framed square on the open gate', dynamic: 'slight push toward the gap' },
        movement: { static: 'stopped at the threshold', dynamic: 'branches shifting, one apple falling' },
        ambient: ['flies in the sun', 'grass to the knee'],
      },
      bench_under_trees: {
        base: 'A weathered wooden bench under two apple trees, seen from a few steps away. Bright patches of low sun on the seat through the leaves.',
        camera: { static: 'eye level, bench centre frame', dynamic: 'settling to a stop' },
        movement: { static: 'seated, hands on knees', dynamic: 'leaf shadows moving over the slats' },
        ending: { kind: 'win', title: 'You sat down.', subtitle: 'Nothing else needed doing.' },
      },
    },
    events: [
      {
        name: 'walk_up_the_lane',
        kind: 'transition',
        from: ['lane'],
        to: 'orchard_gate',
        base: 'Walking on up the rutted lane until the gap in the wall comes level.',
        detail: 'The poplar shadows pass over the frame one at a time; the open gate swings into view on the right.',
        // NOT 'w': that is a drive key, and an authored hotkey may not take a
        // control the player holds. The editor bounces these now; this world
        // shipped one before the rule existed.
        hotkey: 'k',
        // CHOREOGRAPHY. Walking up a lane is a move worth watching, so it is
        // told in two beats rather than one prompt describing the whole walk —
        // the model swaps prompts at a chunk boundary, and one prompt for the
        // whole move lands the gate while the pixels still show the lane. Each
        // beat carries its OWN camera, which is the rule `shared-phase-camera`
        // enforces: a camera that narrates the arrival during beat one
        // teleports the model straight to it.
        phases: [
          {
            base: 'The rutted lane passing underfoot, poplar shadows crossing the frame one at a time.',
            camera: 'low, tilted down at the track ahead',
            minMs: 1200,
          },
          {
            base: 'The stone wall coming level, the gap in it widening to fill the way ahead.',
            camera: 'eye level, the gap centred and growing',
            minMs: 1200,
          },
        ],
        // `minProximity` is the short-side fraction of the frame the object has
        // to fill before the chip arms — the authoring probe MEASURES it for a
        // generated world (`provider/vision/probe.ts`), and this fixture states
        // it by hand so the starter world demonstrates the rule instead of
        // arming from across the field. A gate you can walk through is wide.
        anchor: { label: 'the gap in the wall', aliases: ['gate', 'gap', 'opening'], minProximity: 0.18 },
      },
      {
        name: 'go_to_the_bench',
        kind: 'transition',
        from: ['orchard_gate'],
        to: 'bench_under_trees',
        base: 'Stepping through the gate and crossing the long grass to the bench.',
        detail: 'Grass drags at the shins; the bench comes up centre frame and the camera settles.',
        hotkey: 'e',
        // ARRIVAL. The destination lands when the picture SHOWS it — here, when
        // the scene comes to rest, which is the physical signature of having
        // got there. Fails open after 5s so a stubborn frame can never trap a
        // player mid-event, and says so when it does.
        landWhen: { maxMotion: 12, hits: 1, timeoutMs: 5000 },
        // Deliberately left WITHOUT a minProximity, unlike the gate above: the
        // starter world should show one real `sliver-evidence` warning in the
        // doctrine panel with a working one-click Fix, because a lint nobody
        // ever sees teaches nothing about the rule it enforces.
        anchor: { label: 'the bench', aliases: ['seat', 'bench under the trees'] },
      },
      {
        name: 'listen',
        kind: 'override',
        from: ['lane', 'orchard_gate'],
        base: 'The wind comes up: every leaf and grass head leans the same way, then falls back.',
        detail: 'The frame holds exactly where it is, steady on the same view, while light flickers through moving leaves.',
        hotkey: 'l',
      },
    ],
  }
}

/**
 * The second worked example: a MISSION world.
 *
 * Built by running the mission compiler itself, so the example a newcomer opens
 * is not a hand-drawn imitation of what `add_mission` produces — it IS what it
 * produces. Two objectives, a grounded first step, a consequence scene and the
 * win card the compiler stamps on it.
 */
function questWorld(): { scene: SMScene; missions: SMMission[]; subject: string } {
  const subject = 'a courier in a long coat'
  const opening: SMState = {
    base: 'A third-person rear-view shot of a courier in a long coat standing at the mouth of a wet alley, neon running in the puddles. A steel door sits shut at the far end, a fire escape climbing the brick above it. Cold blue light, rain in the air.',
    camera: { static: 'rear chase, eye level, alley centred', dynamic: 'rear chase, pushing slowly down the alley' },
    movement: { static: 'standing still, coat moving in the wind', dynamic: 'walking on into the alley' },
    ambient: ['rain finding the gutters', 'a sign buzzing somewhere above'],
  }
  const seed: SMWorld = {
    subject,
    entrance: { state: 'alley' },
    scene: { states: { alley: opening }, events: [] },
  }

  const compiled = compileMission(seed, {
    id: 'delivery',
    title: 'The Delivery',
    win: { title: 'DELIVERED', subtitle: 'Whatever it was, it is theirs now.' },
    objectives: [
      {
        id: 'find_door',
        text: 'Reach the steel door',
        action: 'The courier walks the length of the alley, rain coming off the coat, until the steel door fills the frame.',
        grounded: { target: 'steel door', targetAliases: ['metal door', 'door'], proximity: 0.16 },
      },
      {
        id: 'leave_package',
        text: 'Leave the package',
        action: 'The courier crouches and sets a wrapped package against the foot of the door, then straightens.',
        outcome: 'A third-person rear-view shot of a courier in a long coat turning away from a steel door, a wrapped package left at its foot in the rain. Cold blue light, the alley empty ahead.',
        fail: {
          name: 'Open the door instead',
          action: 'The courier tries the handle; it gives, and light spills out into the alley.',
          outcome: 'A third-person rear-view shot of a courier in a long coat frozen in a doorway full of light, the alley behind gone dark. Cold blue light, rain in the air.',
          title: 'SEEN',
          subtitle: 'The job was to leave it and go.',
        },
      },
    ],
  })

  const states: Record<string, SMState> = { alley: opening }
  for (const { id, state } of compiled.states) states[id] = state
  for (const { id, ending } of compiled.endings) {
    const target = states[id]
    if (target) target.ending = ending
  }
  return { scene: { states, events: compiled.events }, missions: [compiled.mission], subject }
}

const QUEST_NAME = 'The Delivery'
const QUEST_DESCRIPTION =
  'A mission: ordered objectives that compiled themselves into the graph — a grounded first step, a consequence, a way to get it wrong.'

const STARTER_NAME = 'A Walk to the Bench'
const STARTER_DESCRIPTION =
  'Three states, two ways forward and a place to stop — the smallest complete world, here to be taken apart.'

/** The honest "blank": one state holding the author's own words, so it opens. */
function blankScene(premise: string): SMScene {
  return {
    states: {
      opening: {
        base: premise || 'Describe what the camera sees here.',
        camera: { static: 'eye level', dynamic: 'slow drift' },
        movement: { static: 'still', dynamic: '' },
      },
    },
    events: [],
  }
}

// ─── Where the bytes go ──────────────────────────────────────────────────────

/** The subset of the DOM Storage interface this store needs — and can be given. */
export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function memoryStore(): KeyValueStore {
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  }
}

/**
 * Safari in private mode has a localStorage that throws on write, so presence is
 * not proof of usability — probe it. Falling back to memory keeps the studio
 * running; `usage().persistent` is how the UI learns to warn about it.
 */
function resolveStorage(): { storage: KeyValueStore; backend: 'localStorage' | 'memory' } {
  try {
    const ls = globalThis.localStorage
    if (ls) {
      const probe = `${DB_KEY}.probe`
      ls.setItem(probe, '1')
      ls.removeItem(probe)
      return { storage: ls, backend: 'localStorage' }
    }
  } catch {
    /* disabled, full, or private mode — fall through */
  }
  return { storage: memoryStore(), backend: 'memory' }
}

function isQuotaError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true
  // Older WebKit/IE report only a numeric code.
  const code = (e as { code?: number }).code
  return code === 22 || code === 1014
}

// ─── The PRODUCER boundary ───────────────────────────────────────────────────
//
// There are two boundaries here, and the difference between them is the whole
// design:
//
//   · A dynamically-produced world — free-text creator skins, editor previews,
//     shared scenarios, an LLM narrator's output — is FAIL-CLOSED: it is
//     validated before it can be loaded. A world that a machine just wrote
//     does not get to run until it validates.
//   · Content a person authored is ADVISORY: it must preserve the "play boots
//     dirty, surface the diagnostics" UX.
//
// So the rule is not "validate everything", which would make authoring
// impossible — you cannot add a state and wire it in the same keystroke. It is
// that MACHINE-produced graph writes must clear the doctrine, and a person's
// must not be stopped mid-thought. This studio already carries that distinction
// as `origin: 'app' | 'agent'` on every tool call, so the gate rides on it.
//
// Only NEW errors count. A world that is already dirty has to stay editable by
// the agent, or the correction round that hands these errors back to the model
// could never fix anything.

/** Doctrine errors as a comparable set: lint id + where it fired. */
function errorKeys(diagnostics: readonly Diagnostic[]): Set<string> {
  return new Set(diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.lint}@${d.path}`))
}

/** Throw unless the mutated world introduced no doctrine error it did not
 *  already have. Called INSIDE the write transaction, before commit — the whole
 *  database is a parsed copy at that point, so throwing here leaves storage
 *  holding the last good state and needs no rollback path. */
function assertNoNewErrors(before: ReadonlySet<string>, world: SMWorld): void {
  const introduced = runDoctrine(world).filter(
    (d) => d.severity === 'error' && !before.has(`${d.lint}@${d.path}`),
  )
  if (introduced.length === 0) return
  throw new StoreError(
    422,
    `the doctrine rejected this batch: ${introduced.length} new error(s)\n` +
      introduced.map((d) => `  - [${d.lint}] ${d.path}: ${d.message}`).join('\n'),
  )
}

// ─── Graph mutators, shared by the REST-ish methods and applyOps ─────────────

function sceneOf(w: StoredWorld): SMScene {
  return w.world.scene
}

function requireState(w: StoredWorld, stateId: string): SMState {
  const st = sceneOf(w).states[stateId]
  if (!st) throw new StoreError(404, `No state "${stateId}" in this world.`)
  return st
}

function findEvent(w: StoredWorld, name: string): SMEvent {
  const ev = sceneOf(w).events.find((e) => e.name === name)
  if (!ev) throw new StoreError(404, `No event "${name}" in this world.`)
  return ev
}

function freeStateId(states: Record<string, SMState>, seed: string): string {
  const base = seed || 'state'
  if (!(base in states)) return base
  for (let n = 2; n < 10000; n++) {
    const candidate = `${base}_${n}`
    if (!(candidate in states)) return candidate
  }
  return rid('state')
}

function freeEventName(events: SMEvent[], seed: string): string {
  const taken = new Set(events.map((e) => e.name))
  const base = seed || 'event'
  if (!taken.has(base)) return base
  for (let n = 2; n < 10000; n++) {
    const candidate = `${base}_${n}`
    if (!taken.has(candidate)) return candidate
  }
  return rid('event')
}

/**
 * Validates the state-shaped fields an op body/patch carries through to
 * normalizeState (add) or mergePatch (update), throwing StoreError(400) naming
 * the first field that does not match a state's real shape. `null` is left
 * alone — mergePatch's own "erase" contract — and so is any key this function
 * does not recognise; only the fields the store itself interprets are guarded.
 */
function checkStateFields(o: Record<string, unknown>, at: string): void {
  // null means ERASE in a patch — legal for optional fields, never for base:
  // a state without a base prompt is a camera pointed at nothing.
  if (o['base'] === null) {
    throw new StoreError(400, `${at}: "base" cannot be erased — a state always has a base prompt.`)
  }
  if (o['base'] !== undefined && typeof o['base'] !== 'string') {
    throw new StoreError(400, `${at}: "base" must be a string, got ${typeof o['base']}.`)
  }
  if (o['camera'] !== undefined && o['camera'] !== null && !isLayerPair(o['camera'])) {
    throw new StoreError(400, `${at}: "camera" must be {static, dynamic} strings.`)
  }
  if (o['movement'] !== undefined && o['movement'] !== null && !isLayerPair(o['movement'])) {
    throw new StoreError(400, `${at}: "movement" must be {static, dynamic} strings.`)
  }
  if (o['ambient'] !== undefined && o['ambient'] !== null && !isStringArray(o['ambient'])) {
    throw new StoreError(400, `${at}: "ambient" must be an array of strings.`)
  }
  if (o['ending'] !== undefined && o['ending'] !== null && !isEnding(o['ending'])) {
    throw new StoreError(400, `${at}: "ending" must be {kind: "win"|"lose", title}.`)
  }
  // Display copy and the arrival noun. Validated like every other field even
  // though no lint reads them — the doctrine's silence is about POLICING their
  // prose, not about letting a number in where a sentence belongs.
  for (const key of ['narration', 'arriveLabel'] as const) {
    if (o[key] !== undefined && o[key] !== null && typeof o[key] !== 'string') {
      throw new StoreError(400, `${at}: "${key}" must be a string, got ${typeof o[key]}.`)
    }
  }
  if (o['autopilot'] !== undefined && o['autopilot'] !== null && !isAutopilot(o['autopilot'])) {
    throw new StoreError(400, `${at}: "autopilot" must be { movement?, lookHorizontal?, lookVertical?, keepCentered?: { label, aliases? } } using the control grammar's own values.`)
  }
  if (o['variants'] !== undefined && o['variants'] !== null && !Array.isArray(o['variants'])) {
    throw new StoreError(400, `${at}: "variants" must be an array.`)
  }
}

/**
 * `body` arrives as the store's structural truth — a JSON object from the
 * agent, the CLI's `--ops` blob, or (typed, and so trivially valid) one of the
 * REST-ish methods below. Either way this is the boundary: every field it
 * reads is checked here, not assumed, and a bad one is refused by name.
 */
/** An objective, by shape. The rest of its fields are the compiler's business;
 *  what the BOUNDARY must guarantee is the two that everything keys off. */
function isObjective(v: unknown): v is SMObjective {
  return isRecord(v) && typeof v['id'] === 'string' && v['id'].trim() !== ''
    && typeof v['text'] === 'string' && v['text'].trim() !== ''
}

function isWin(v: unknown): v is { title: string; subtitle?: string } {
  if (!isRecord(v) || typeof v['title'] !== 'string') return false
  return v['subtitle'] === undefined || typeof v['subtitle'] === 'string'
}

function opAddState(w: StoredWorld, body: Record<string, unknown>): Diagnostic[] {
  const sc = sceneOf(w)
  const { id, ...rest } = body
  if (!isNullableString(id)) {
    throw new StoreError(400, `add_state: "id" must be a string, got ${typeof id}.`)
  }
  checkStateFields(rest, 'add_state')
  const wanted = str(id).trim()
  if (wanted && wanted in sc.states) {
    throw new StoreError(400, `A state called "${wanted}" already exists. Pick another id.`)
  }
  const stateId = wanted || freeStateId(sc.states, slugify(str(rest['base']).split(/[.,;]/)[0] ?? '').replace(/-/g, '_'))
  sc.states[stateId] = normalizeState(rest)

  const out: Diagnostic[] = []
  // A world with no entrance cannot be opened, and the first state added is the
  // only defensible default. Say that it happened rather than doing it silently.
  if (!w.world.entrance) {
    w.world.entrance = { state: stateId }
    out.push(diag('store/entrance', 'info', 'entrance', `Entrance set to "${stateId}" — it was the first state in this world.`))
  }
  return out
}

function opUpdateState(w: StoredWorld, stateId: string, patch: Record<string, unknown>): Diagnostic[] {
  const st = requireState(w, stateId)
  checkStateFields(patch, `update_state "${stateId}"`)
  mergePatch(st, patch)
  return []
}

function opDeleteState(w: StoredWorld, stateId: string): Diagnostic[] {
  const sc = sceneOf(w)
  requireState(w, stateId)
  delete sc.states[stateId]

  const out: Diagnostic[] = []
  const orphaned: string[] = []
  const detached: string[] = []
  // SET-PIECES are not pruned here, deliberately: dropping a beat would rewrite
  // an author's pacing to hide their own edit from them. The doctrine reports
  // the rot instead (`sequence-beat-missing`), and this says it at the moment
  // it happens rather than leaving it to be discovered on the lints panel.
  const walkedBy = (w.world.sequences ?? []).filter((q) => q.beats.some((b) => b.state === stateId))
  if (walkedBy.length > 0) {
    out.push(diag('store/sequence-beat', 'warning', `sequences`,
      `${walkedBy.length} set-piece(s) walk through "${stateId}" and will now stop there: ${walkedBy.map((q) => q.title).join(', ')}.`))
  }
  for (const ev of sc.events) {
    if (ev.from.includes(stateId)) ev.from = ev.from.filter((f) => f !== stateId)
    if (ev.to === stateId) {
      delete ev.to
      detached.push(ev.name)
    }
  }
  sc.events = sc.events.filter((ev) => {
    if (ev.from.length > 0) return true
    orphaned.push(ev.name)
    return false
  })

  if (orphaned.length) {
    out.push(diag('store/cascade', 'info', 'scene.events',
      `Also deleted ${orphaned.length} event${orphaned.length === 1 ? '' : 's'} left with no source state: ${orphaned.join(', ')}.`))
  }
  if (detached.length) {
    out.push(diag('store/cascade', 'warning', 'scene.events',
      `${detached.length} event${detached.length === 1 ? '' : 's'} pointed at "${stateId}" and now lead nowhere: ${detached.join(', ')}.`))
  }
  if (w.world.entrance?.state === stateId) {
    delete w.world.entrance
    out.push(diag('store/entrance', 'warning', 'entrance',
      `"${stateId}" was the entrance. This world has no entrance now and cannot be played until you set one.`))
  }
  return out
}

/**
 * Rename a state, and carry every reference with it.
 *
 * Until now there was no rename op, which meant the only way to change an id
 * here was delete-and-re-add — and `opDeleteState` above is a CASCADE: it
 * drops the state out of every event's `from`, deletes events left with no
 * source, forgets the entrance, and warns that set-pieces now stop short.
 * Doing that to rename something silently rewrites the author's graph.
 *
 * So this is a rekey, not a replace. Every site `opDeleteState` had to clean up
 * is a site that has to be REPOINTED here — they are the same list on purpose,
 * and set-pieces are included (delete leaves those alone deliberately, because
 * a deleted state really did break the walk; a renamed one did not).
 */
function opRenameState(w: StoredWorld, from: string, to: string): Diagnostic[] {
  const sc = sceneOf(w)
  requireState(w, from)
  const id = to.trim()
  if (!id) throw new StoreError(400, 'rename_state: the new id cannot be empty.')
  if (id === from) return []
  if (id in sc.states) {
    throw new StoreError(400, `rename_state: a state called "${id}" already exists.`)
  }

  // Rebuild the record rather than delete-then-set, so the state keeps its
  // place in the order the editor lays out.
  const next: Record<string, (typeof sc.states)[string]> = {}
  for (const [key, value] of Object.entries(sc.states)) next[key === from ? id : key] = value
  sc.states = next

  let events = 0
  for (const ev of sc.events) {
    if (ev.from.includes(from)) {
      ev.from = ev.from.map((f) => (f === from ? id : f))
      events += 1
    }
    if (ev.to === from) {
      ev.to = id
      events += 1
    }
  }
  if (w.world.entrance?.state === from) w.world.entrance = { ...w.world.entrance, state: id }
  let beats = 0
  for (const q of w.world.sequences ?? []) {
    // A set-piece here is addressed purely by its beats — it carries no `from`
    // field of its own, so its first beat IS its entry point and is
    // repointed by the loop below like any other.
    for (const b of q.beats) {
      if (b.state === from) {
        b.state = id
        beats += 1
      }
    }
  }
  for (const c of w.world.cutscenes ?? []) {
    if (c.to === from) c.to = id
  }
  for (const b of w.world.story?.beats ?? []) {
    if (b.states?.includes(from)) b.states = b.states.map((s) => (s === from ? id : s))
  }

  return [
    diag('store/rename', 'info', `states.${id}`,
      `Renamed "${from}" to "${id}" and repointed ${events} event reference(s)` +
      `${beats > 0 ? ` and ${beats} set-piece beat(s)` : ''}.`),
  ]
}

/** A phase list: every beat needs its own scene, and the numbers must be
 *  numbers — a phase with a string minMs would silently never advance. */
function isPhases(v: unknown): v is SMEvent['phases'] {
  if (!Array.isArray(v) || v.length === 0) return false
  return v.every((p) => {
    if (!isRecord(p)) return false
    if (typeof p['base'] !== 'string' || p['base'].trim() === '') return false
    for (const k of ['camera', 'movement', 'detail']) {
      if (p[k] !== undefined && typeof p[k] !== 'string') return false
    }
    if (p['minMs'] !== undefined && typeof p['minMs'] !== 'number') return false
    return true
  })
}

/** Arrival evidence. Every field is optional, but a landWhen with NOTHING in it
 *  is a gate that can never open — the doctrine's `auto-needs-pixels` catches
 *  the auto case; this catches the empty object at the boundary. */
function isLandWhen(v: unknown): v is SMEvent['landWhen'] {
  if (!isRecord(v)) return false
  if (v['label'] !== undefined && typeof v['label'] !== 'string') return false
  if (v['aliases'] !== undefined && !isStringArray(v['aliases'])) return false
  for (const k of ['minExtent', 'minLuminance', 'maxLuminance', 'minMotion', 'maxMotion', 'hits', 'timeoutMs']) {
    if (v[k] !== undefined && typeof v[k] !== 'number') return false
  }
  if (v['auto'] !== undefined && typeof v['auto'] !== 'boolean') return false
  return Object.keys(v).length > 0
}

/** An anchor as the play-time chip layer needs it: a label to detect, optional
 *  probe-verified aliases, and the geometry the probe measured. */
function isEventAnchor(v: unknown): v is SMEvent['anchor'] {
  if (!isRecord(v)) return false
  if (typeof v['label'] !== 'string' || v['label'].trim() === '') return false
  if (v['aliases'] !== undefined && !isStringArray(v['aliases'])) return false
  if (v['minProximity'] !== undefined && typeof v['minProximity'] !== 'number') return false
  const aspect = v['expectedAspect']
  if (aspect !== undefined) {
    if (!isRecord(aspect) || typeof aspect['min'] !== 'number' || typeof aspect['max'] !== 'number') return false
  }
  return true
}

function opAddEvent(w: StoredWorld, body: Record<string, unknown>): Diagnostic[] {
  const sc = sceneOf(w)

  // THREE kinds, not two. `terminal` was in the schema and drawn by the graph
  // canvas and could never be WRITTEN — the update path already accepted it,
  // and only the add path did not, which is how a kind ends up existing
  // everywhere except where it is created.
  const kindRaw = body['kind']
  if (kindRaw !== 'transition' && kindRaw !== 'override' && kindRaw !== 'terminal') {
    throw new StoreError(400, `add_event: "kind" must be "transition", "override" or "terminal", got ${JSON.stringify(kindRaw)}.`)
  }
  const kind = kindRaw

  const rawFrom = body['from']
  if (!isStateRefs(rawFrom)) {
    throw new StoreError(400, 'add_event: "from" must be a state id or an array of state ids.')
  }
  const from = (Array.isArray(rawFrom) ? rawFrom : [rawFrom]).filter((f) => f.length > 0)
  if (from.length === 0) throw new StoreError(400, 'An event needs at least one "from" state.')
  const unreachable = from.filter((f) => !(f in sc.states))
  if (unreachable.length) throw new StoreError(400, `No such state: ${unreachable.join(', ')}.`)

  const to = body['to']
  if (!isOptionalString(to)) {
    throw new StoreError(400, `add_event: "to" must be a string, got ${typeof to}.`)
  }
  // A destination is a state OR a cutscene: the runtime resolves a transition's
  // `to` against cutscene ids FIRST, and a store that only knew about states
  // made the mechanic unauthorable — the runtime could play a cut nobody was
  // allowed to point at.
  if (to && !isDestination(w, to)) {
    throw new StoreError(400, `No such state or cutscene: ${to}.`)
  }

  const nameField = body['name']
  if (!isOptionalString(nameField)) {
    throw new StoreError(400, `add_event: "name" must be a string, got ${typeof nameField}.`)
  }
  const wanted = str(nameField).trim()
  if (wanted && sc.events.some((e) => e.name === wanted)) {
    throw new StoreError(400, `An event called "${wanted}" already exists. Event names are the key, so they must be unique.`)
  }
  const name = wanted || freeEventName(sc.events, to ? `go_to_${to}` : `${kind}_${sc.events.length + 1}`)

  const base = body['base']
  if (!isOptionalString(base)) {
    throw new StoreError(400, `add_event: "base" must be a string, got ${typeof base}.`)
  }
  const detail = body['detail']
  if (!isOptionalString(detail)) {
    throw new StoreError(400, `add_event: "detail" must be a string, got ${typeof detail}.`)
  }
  const hotkey = body['hotkey']
  if (!isNullableString(hotkey)) {
    throw new StoreError(400, `add_event: "hotkey" must be a string, got ${typeof hotkey}.`)
  }

  // The REST of the event schema. This used to stop at `hotkey`, building the
  // event from a five-field allowlist — so `anchor`, `requires`, `grants`,
  // `hidden` and `oneShot` were dropped on the floor by `add_event` while
  // `update_event` (which merges its patch wholesale) carried them fine. The
  // failure was invisible in the worst way: the op SUCCEEDED. A kernel that
  // authored an anchored interaction got an event with no anchor, no error,
  // and no way to tell — anchors only ever survived when a later correction
  // round happened to re-send them as update_event, which is why the arcade
  // layer worked at all. Same story for the flag algebra the
  // `unreachable-require` lint reads.
  const anchor = body['anchor']
  if (anchor !== undefined && !isEventAnchor(anchor)) {
    throw new StoreError(400, 'add_event: "anchor" must be { label, aliases?, minProximity?, expectedAspect? }.')
  }
  const requires = body['requires']
  if (requires !== undefined && !isStringArray(requires)) {
    throw new StoreError(400, 'add_event: "requires" must be an array of flag names.')
  }
  const grants = body['grants']
  if (grants !== undefined && !isStringArray(grants)) {
    throw new StoreError(400, 'add_event: "grants" must be an array of flag names.')
  }
  const hidden = body['hidden']
  if (hidden !== undefined && typeof hidden !== 'boolean') {
    throw new StoreError(400, `add_event: "hidden" must be a boolean, got ${typeof hidden}.`)
  }
  const oneShot = body['oneShot']
  if (oneShot !== undefined && typeof oneShot !== 'boolean') {
    throw new StoreError(400, `add_event: "oneShot" must be a boolean, got ${typeof oneShot}.`)
  }
  const lockedHint = body['lockedHint']
  if (!isOptionalString(lockedHint)) {
    throw new StoreError(400, `add_event: "lockedHint" must be a string, got ${typeof lockedHint}.`)
  }
  const phases = body['phases']
  if (phases !== undefined && !isPhases(phases)) {
    throw new StoreError(400, 'add_event: "phases" must be an array of { base, camera?, movement?, detail?, minMs? }.')
  }
  const landWhen = body['landWhen']
  if (landWhen !== undefined && !isLandWhen(landWhen)) {
    throw new StoreError(400, 'add_event: "landWhen" must be { label?, aliases?, minExtent?, minLuminance?, maxLuminance?, minMotion?, maxMotion?, hits?, timeoutMs?, auto? }.')
  }
  // The event's own framing and timing. Carried here rather than only on a
  // PHASE, because a one-beat move should not have to be broken into phases
  // just to be framed differently from the rooms on either side of it.
  const camera = body['camera']
  if (!isOptionalString(camera)) {
    throw new StoreError(400, `add_event: "camera" must be a string, got ${typeof camera}.`)
  }
  const movement = body['movement']
  if (!isOptionalString(movement)) {
    throw new StoreError(400, `add_event: "movement" must be a string, got ${typeof movement}.`)
  }
  const narration = body['narration']
  if (!isOptionalString(narration)) {
    throw new StoreError(400, `add_event: "narration" must be a string, got ${typeof narration}.`)
  }
  const waypoint = body['waypoint']
  if (waypoint !== undefined && !isWaypoint(waypoint)) {
    throw new StoreError(400, 'add_event: "waypoint" must be { label, distanceM, speedMs?, approachM? } with positive distances.')
  }
  const terminal = body['terminal']
  if (terminal !== undefined && !isTerminal(terminal)) {
    throw new StoreError(400, 'add_event: "terminal" must be { persona, facts?: [{ text, requires? }], greeting? }.')
  }
  const drive = body['drive']
  if (drive !== undefined && !isDrive(drive)) {
    throw new StoreError(400, 'add_event: "drive" must be { movement?: forward|back|strafe_left|strafe_right, lookHorizontal?: left|right, lookVertical?: up|down }.')
  }
  const drivePulseMs = body['drivePulseMs']
  if (drivePulseMs !== undefined && (typeof drivePulseMs !== 'number' || !Number.isFinite(drivePulseMs) || drivePulseMs < 0)) {
    throw new StoreError(400, 'add_event: "drivePulseMs" must be a non-negative number of milliseconds.')
  }
  const minPlayMs = body['minPlayMs']
  if (minPlayMs !== undefined && (typeof minPlayMs !== 'number' || !Number.isFinite(minPlayMs) || minPlayMs < 0)) {
    throw new StoreError(400, 'add_event: "minPlayMs" must be a non-negative number of milliseconds.')
  }
  const autoAfterMs = body['autoAfterMs']
  if (autoAfterMs !== undefined && (typeof autoAfterMs !== 'number' || !Number.isFinite(autoAfterMs) || autoAfterMs < 0)) {
    throw new StoreError(400, 'add_event: "autoAfterMs" must be a non-negative number of milliseconds.')
  }

  const ev: SMEvent = { name, kind, from }
  if (to) ev.to = to
  if (base !== undefined) ev.base = base
  if (detail !== undefined) ev.detail = detail
  if (hotkey !== undefined) ev.hotkey = hotkey
  if (anchor !== undefined) ev.anchor = anchor
  if (requires !== undefined) ev.requires = requires
  if (grants !== undefined) ev.grants = grants
  if (hidden !== undefined) ev.hidden = hidden
  if (oneShot !== undefined) ev.oneShot = oneShot
  if (lockedHint !== undefined) ev.lockedHint = lockedHint
  if (phases !== undefined) ev.phases = phases
  if (landWhen !== undefined) ev.landWhen = landWhen
  if (camera !== undefined) ev.camera = camera
  if (movement !== undefined) ev.movement = movement
  if (narration !== undefined) ev.narration = narration
  if (drive !== undefined) ev.drive = drive
  if (waypoint !== undefined) ev.waypoint = waypoint
  if (terminal !== undefined) ev.terminal = terminal
  if (drivePulseMs !== undefined) ev.drivePulseMs = drivePulseMs
  if (minPlayMs !== undefined) ev.minPlayMs = minPlayMs
  if (autoAfterMs !== undefined) ev.autoAfterMs = autoAfterMs
  sc.events.push(ev)

  const out: Diagnostic[] = []
  if (kind === 'transition' && !to) {
    out.push(diag('store/dangling-transition', 'warning', `scene.events.${name}`,
      'This transition has no destination state, so it will not appear as an edge in the graph. Set "To state" to finish it.'))
  }
  return out
}

function opUpdateEvent(w: StoredWorld, name: string, patch: Record<string, unknown>): Diagnostic[] {
  const sc = sceneOf(w)
  const ev = findEvent(w, name)
  const next: Record<string, unknown> = { ...patch }

  // Renaming is a key change, so it is checked before anything is mutated.
  const nameField = next['name']
  if (!isNullableString(nameField)) {
    throw new StoreError(400, `update_event: "name" must be a string, got ${typeof nameField}.`)
  }
  const rename = str(nameField).trim()
  if (rename && rename !== name) {
    if (sc.events.some((e) => e.name === rename)) {
      throw new StoreError(400, `An event called "${rename}" already exists.`)
    }
  } else {
    delete next["name"]
  }

  const fromField = next['from']
  if (fromField !== undefined) {
    if (!isStringArray(fromField)) {
      throw new StoreError(400, `update_event: "from" must be an array of state ids, got ${typeof fromField}.`)
    }
    if (fromField.length === 0) throw new StoreError(400, 'An event needs at least one "from" state.')
    const unreachable = fromField.filter((f) => !(f in sc.states))
    if (unreachable.length) throw new StoreError(400, `No such state: ${unreachable.join(', ')}.`)
    next["from"] = fromField
  }

  const toField = next['to']
  if (!isNullableString(toField)) {
    throw new StoreError(400, `update_event: "to" must be a string, got ${typeof toField}.`)
  }
  if (toField && !isDestination(w, toField)) {
    throw new StoreError(400, `No such state or cutscene: ${toField}.`)
  }

  const kindField = next['kind']
  // null-erase is for optional fields; every event HAS a kind.
  if (kindField === null) {
    throw new StoreError(400, 'update_event: "kind" cannot be erased — every event has a kind.')
  }
  if (
    kindField !== undefined &&
    kindField !== 'transition' && kindField !== 'override' && kindField !== 'terminal'
  ) {
    throw new StoreError(400, 'update_event: "kind" must be "transition", "override", or "terminal".')
  }
  const baseField = next['base']
  if (!isNullableString(baseField)) {
    throw new StoreError(400, `update_event: "base" must be a string, got ${typeof baseField}.`)
  }
  const detailField = next['detail']
  if (!isNullableString(detailField)) {
    throw new StoreError(400, `update_event: "detail" must be a string, got ${typeof detailField}.`)
  }
  const hotkeyField = next['hotkey']
  if (!isNullableString(hotkeyField)) {
    throw new StoreError(400, `update_event: "hotkey" must be a string, got ${typeof hotkeyField}.`)
  }

  const phasesField = next['phases']
  if (phasesField !== undefined && phasesField !== null && !isPhases(phasesField)) {
    throw new StoreError(400, 'update_event: "phases" must be an array of { base, camera?, movement?, detail?, minMs? }.')
  }
  const landWhenField = next['landWhen']
  if (landWhenField !== undefined && landWhenField !== null && !isLandWhen(landWhenField)) {
    throw new StoreError(400, 'update_event: "landWhen" must be an object of evidence thresholds.')
  }
  // `mergePatch` carries every remaining key through untouched, so a field is
  // only as safe as its check here — a string where a duration belongs would
  // reach the player as `NaN` and hold a beat forever.
  for (const key of ['camera', 'movement', 'narration'] as const) {
    const v = next[key]
    if (v !== undefined && v !== null && typeof v !== 'string') {
      throw new StoreError(400, `update_event: "${key}" must be a string, got ${typeof v}.`)
    }
  }
  const waypointField = next['waypoint']
  if (waypointField !== undefined && waypointField !== null && !isWaypoint(waypointField)) {
    throw new StoreError(400, 'update_event: "waypoint" must be { label, distanceM, speedMs?, approachM? } with positive distances.')
  }
  const terminalField = next['terminal']
  if (terminalField !== undefined && terminalField !== null && !isTerminal(terminalField)) {
    throw new StoreError(400, 'update_event: "terminal" must be { persona, facts?: [{ text, requires? }], greeting? }.')
  }
  const driveField = next['drive']
  if (driveField !== undefined && driveField !== null && !isDrive(driveField)) {
    throw new StoreError(400, 'update_event: "drive" must be { movement?, lookHorizontal?, lookVertical? } with the control grammar\'s own values.')
  }
  for (const key of ['minPlayMs', 'autoAfterMs', 'drivePulseMs'] as const) {
    const v = next[key]
    if (v !== undefined && v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
      throw new StoreError(400, `update_event: "${key}" must be a non-negative number of milliseconds.`)
    }
  }

  mergePatch(ev, next)
  return []
}

/** A console's persona and its authored ledger. The FACTS are checked
 *  individually: a malformed one would be silently dropped from what the
 *  console may say, which is the kind of quiet the truth ledger cannot afford. */
function isTerminal(v: unknown): v is NonNullable<SMEvent['terminal']> {
  if (!isRecord(v)) return false
  if (typeof v['persona'] !== 'string' || v['persona'].trim() === '') return false
  if (v['greeting'] !== undefined && typeof v['greeting'] !== 'string') return false
  const facts = v['facts']
  if (facts !== undefined) {
    if (!Array.isArray(facts)) return false
    for (const f of facts) {
      if (!isRecord(f) || typeof f['text'] !== 'string' || f['text'].trim() === '') return false
      if (f['requires'] !== undefined && !isStringArray(f['requires'])) return false
    }
  }
  return true
}

/** Where a transition may point: a state, or a cutscene that lands in one. */
function isDestination(w: StoredWorld, id: string): boolean {
  return id in sceneOf(w).states || (w.world.cutscenes ?? []).some((c) => c.id === id)
}

/**
 * A clip on a seam.
 *
 * `from` and `to` must be real states — a cut is a bridge between two places in
 * the graph, and one that lands nowhere would strand the player mid-cinematic.
 * The VIDEO is deliberately not checked: a missing clip fails open so a world
 * stays playable before its final art lands, and a store that refused an
 * unmade clip would make that impossible to author.
 */
function opAddCutscene(w: StoredWorld, spec: Record<string, unknown>): Diagnostic[] {
  const id = str(opField(spec, ['id', 'cutsceneId'])).trim()
  if (!id) throw new StoreError(400, 'add_cutscene: needs an "id" — a transition names it to trigger the cut.')
  const video = str(spec['video']).trim()
  if (!video) throw new StoreError(400, 'add_cutscene: needs a "video" URL.')
  const from = str(opField(spec, ['from', 'fromState'])).trim()
  const to = str(opField(spec, ['to', 'toState'])).trim()
  requireState(w, from)
  requireState(w, to)
  if (id in sceneOf(w).states) {
    throw new StoreError(400, `"${id}" is already a state id — a cutscene id has to be distinct, because a transition's "to" resolves cutscenes FIRST.`)
  }
  const existing = w.world.cutscenes ?? []
  if (existing.some((c) => c.id === id)) throw new StoreError(400, `A cutscene called "${id}" already exists.`)
  const requires = spec['requires']
  if (requires !== undefined && !isStringArray(requires)) {
    throw new StoreError(400, 'add_cutscene: "requires" must be an array of flag names.')
  }
  const label = spec['label']
  if (label !== undefined && typeof label !== 'string') {
    throw new StoreError(400, 'add_cutscene: "label" must be a string.')
  }
  const subtitle = spec['subtitle']
  if (subtitle !== undefined && typeof subtitle !== 'string') {
    throw new StoreError(400, 'add_cutscene: "subtitle" must be a string.')
  }
  w.world.cutscenes = [...existing, {
    id, video, from, to,
    ...(typeof label === 'string' && label ? { label } : {}),
    ...(typeof subtitle === 'string' && subtitle ? { subtitle } : {}),
    ...(requires && requires.length ? { requires } : {}),
  }]
  return []
}

function opRemoveCutscene(w: StoredWorld, id: string): Diagnostic[] {
  const existing = w.world.cutscenes ?? []
  if (!existing.some((c) => c.id === id)) throw new StoreError(404, `No such cutscene: ${id}.`)
  w.world.cutscenes = existing.filter((c) => c.id !== id)
  return []
}

/**
 * The story above the graph: what this world IS and what has happened in it.
 *
 * `set_story` replaces the logline and arc and KEEPS the beats — the beats are
 * a record of events, and rewriting the premise does not unhappen them.
 */
function opSetStory(w: StoredWorld, spec: Record<string, unknown>): Diagnostic[] {
  const logline = str(spec['logline']).trim()
  if (!logline) throw new StoreError(400, 'set_story: needs a "logline" — one sentence saying what this world dramatically is.')
  const rawArc = spec['arc']
  if (rawArc !== undefined && !isStringArray(rawArc)) {
    throw new StoreError(400, 'set_story: "arc" must be an array of stage names.')
  }
  const existing = w.world.story
  w.world.story = {
    logline,
    ...(rawArc && rawArc.length ? { arc: rawArc } : {}),
    ...(existing?.beats?.length ? { beats: existing.beats } : {}),
  }
  return []
}

/**
 * Append what just happened.
 *
 * The beats are the agent's MEMORY: what already happened, so the director
 * doesn't contradict or repeat it. A world with no story yet gets one seeded
 * from its own name rather than refusing the beat: losing the record of an
 * action because nobody wrote a logline first would be the wrong thing to be
 * strict about.
 */
function opAddStoryBeat(w: StoredWorld, spec: Record<string, unknown>): Diagnostic[] {
  const summary = str(spec['summary']).trim()
  if (!summary) throw new StoreError(400, 'add_story_beat: needs a "summary" of what happened.')
  const states = spec['states']
  if (states !== undefined && !isStringArray(states)) {
    throw new StoreError(400, 'add_story_beat: "states" must be an array of state ids.')
  }
  const beat = {
    summary,
    ...(typeof spec['arc'] === 'string' && spec['arc'] ? { arc: spec['arc'] } : {}),
    ...(states && states.length ? { states } : {}),
    ...(typeof spec['sequence'] === 'string' && spec['sequence'] ? { sequence: spec['sequence'] } : {}),
  }
  const story = w.world.story ?? { logline: w.world.name ?? 'this world' }
  w.world.story = { ...story, beats: [...(story.beats ?? []), beat] }
  return []
}

/** One beat of a set-piece: a state that EXISTS, and how long to stay in it. */
function isSequenceBeat(v: unknown, states: Record<string, SMState>): v is SMSequenceBeat {
  if (!isRecord(v)) return false
  const state = v['state']
  if (typeof state !== 'string' || !(state in states)) return false
  const dwell = v['dwell']
  if (dwell === undefined || dwell === 'settle' || dwell === 'input') return true
  if (isRecord(dwell) && typeof dwell['ms'] === 'number' && Number.isFinite(dwell['ms']) && dwell['ms'] >= 0) {
    return Object.keys(dwell).length === 1
  }
  return false
}

/**
 * A set-piece, checked against the graph it groups.
 *
 * The beats must name states that EXIST — a sequence is a reading order over
 * the scene, not a second place to declare one. A dangling beat would be a
 * set-piece that stops halfway through with nothing to show, discovered by a
 * player rather than by an author.
 */
function opAddSequence(w: StoredWorld, spec: Record<string, unknown>): Diagnostic[] {
  const sc = sceneOf(w)
  const id = str(opField(spec, ['id', 'sequenceId'])).trim()
  const title = str(spec['title']).trim()
  if (!id) throw new StoreError(400, 'add_sequence: needs an "id".')
  if (!title) throw new StoreError(400, 'add_sequence: needs a "title" — a set-piece is shown to an author as one track, and a track needs a name.')
  const rawBeats = spec['beats']
  if (!Array.isArray(rawBeats) || rawBeats.length === 0) {
    throw new StoreError(400, 'add_sequence: "beats" must be a non-empty array of { state, dwell? }.')
  }
  const beats: SMSequenceBeat[] = rawBeats.map((b, i) => {
    if (!isSequenceBeat(b, sc.states)) {
      const named = isRecord(b) && typeof b['state'] === 'string' ? ` — "${b['state']}"` : ''
      throw new StoreError(400, `add_sequence: beat ${i + 1} must be { state, dwell?: "settle" | "input" | { ms } } naming a state that exists${named}.`)
    }
    return b
  })
  const existing = w.world.sequences ?? []
  if (existing.some((q) => q.id === id)) {
    throw new StoreError(400, `A sequence called "${id}" already exists.`)
  }
  w.world.sequences = [...existing, { id, title, beats }]
  return []
}

function opRemoveSequence(w: StoredWorld, id: string): Diagnostic[] {
  const existing = w.world.sequences ?? []
  if (!existing.some((q) => q.id === id)) throw new StoreError(404, `No such sequence: ${id}.`)
  w.world.sequences = existing.filter((q) => q.id !== id)
  return []
}

function opDeleteEvent(w: StoredWorld, name: string): Diagnostic[] {
  findEvent(w, name)
  const sc = sceneOf(w)
  sc.events = sc.events.filter((e) => e.name !== name)
  return []
}

function opSetEntrance(w: StoredWorld, body: Record<string, unknown>): Diagnostic[] {
  const stateField = body['state']
  if (!isNullableString(stateField)) {
    throw new StoreError(400, `set_entrance: "state" must be a string, got ${typeof stateField}.`)
  }
  const state = str(stateField).trim()
  if (!state) throw new StoreError(400, 'Entrance needs a state id.')
  requireState(w, state)

  const rawImage = body['image']
  let image = w.world.entrance?.image
  if (rawImage !== undefined && rawImage !== null) {
    const parsed = readEntranceImage(rawImage)
    if (!parsed) throw new StoreError(400, 'set_entrance: "image" must be an object with a string "src".')
    image = parsed
  }
  w.world.entrance = image ? { state, image } : { state }
  return []
}

/** The subject lock and style tail, written through the op vocabulary rather
 *  than only through the world's metadata patch. Both are world-level prose the
 *  mission compiler reads, so they are validated as prose and nothing else. */
function opSetSubject(w: StoredWorld, patch: Record<string, unknown>): Diagnostic[] {
  for (const k of ['subject', 'styleTail']) {
    const v = patch[k]
    if (v !== undefined && v !== null && typeof v !== 'string') {
      throw new StoreError(400, `set_subject: "${k}" must be a string, got ${typeof v}.`)
    }
  }
  if (patch['subject'] !== undefined) {
    if (patch['subject'] === null) delete w.world.subject
    else w.world.subject = patch['subject'] as string
  }
  if (patch['styleTail'] !== undefined) {
    if (patch['styleTail'] === null) delete w.world.styleTail
    else w.world.styleTail = patch['styleTail'] as string
  }
  return []
}

/** A destination the player drives to. The distances have to be POSITIVE: a
 *  zero-metre waypoint would fire on arrival at the state it starts in, and a
 *  negative one never counts down at all. */
function isWaypoint(v: unknown): v is NonNullable<SMEvent['waypoint']> {
  if (!isRecord(v)) return false
  if (typeof v['label'] !== 'string' || v['label'].trim() === '') return false
  if (typeof v['distanceM'] !== 'number' || !Number.isFinite(v['distanceM']) || v['distanceM'] <= 0) return false
  for (const k of ['speedMs', 'approachM']) {
    const n = v[k]
    if (n !== undefined && (typeof n !== 'number' || !Number.isFinite(n) || n <= 0)) return false
  }
  return Object.keys(v).every((k) => ['label', 'distanceM', 'speedMs', 'approachM'].includes(k))
}

/** Control-channel inputs, checked against the grammar the transport speaks.
 *  An unknown axis value would reach `driveCommands` and throw there — which is
 *  the right behaviour at the transport and the wrong place to find out. */
function isDrive(v: unknown): v is SMDrive {
  if (!isRecord(v)) return false
  const allowed: Record<string, readonly string[]> = {
    movement: ['forward', 'back', 'strafe_left', 'strafe_right'],
    lookHorizontal: ['left', 'right'],
    lookVertical: ['up', 'down'],
  }
  for (const [key, values] of Object.entries(allowed)) {
    const got = v[key]
    if (got !== undefined && (typeof got !== 'string' || !values.includes(got))) return false
  }
  return Object.keys(v).every((k) => k in allowed)
}

/** A state's standing camera drive, plus the label it tries to keep centred. */
function isAutopilot(v: unknown): boolean {
  if (!isRecord(v)) return false
  const { keepCentered, ...axes } = v
  if (!isDrive(axes)) return false
  if (keepCentered === undefined) return true
  if (!isRecord(keepCentered)) return false
  if (typeof keepCentered['label'] !== 'string' || keepCentered['label'].trim() === '') return false
  if (keepCentered['aliases'] !== undefined && !isStringArray(keepCentered['aliases'])) return false
  return Object.keys(keepCentered).every((k) => k === 'label' || k === 'aliases')
}

/** An alternate prompt, as the A/B surfaces need it: a label to put on the chip
 *  and prose to swap in. Everything else is optional, exactly as on a state. */
function isPromptVariant(v: unknown): v is SMPromptVariant {
  if (!isRecord(v)) return false
  if (typeof v['label'] !== 'string' || v['label'].trim() === '') return false
  if (typeof v['base'] !== 'string') return false
  for (const k of ['camera', 'movement']) {
    const pair = v[k]
    if (pair === undefined) continue
    if (!isRecord(pair) || typeof pair['static'] !== 'string' || typeof pair['dynamic'] !== 'string') return false
  }
  if (v['ambient'] !== undefined && !isStringArray(v['ambient'])) return false
  return true
}

function opAddVariant(w: StoredWorld, stateId: string, variant: unknown): Diagnostic[] {
  const st = requireState(w, stateId)
  if (variant === undefined) throw new StoreError(400, 'add_variant needs a "variant" value.')
  // This op used to accept ANYTHING and store it, because `variants` was typed
  // `unknown[]` and nothing ever read one back. A field nobody reads is a field
  // nobody validates; now that the player boots into a variant, an unusable one
  // has to be refused at the boundary like every other op's payload.
  if (!isPromptVariant(variant)) {
    throw new StoreError(400, 'add_variant: a variant needs a non-empty "label" and a "base", with optional camera/movement {static,dynamic} and ambient[].')
  }
  const existing = Array.isArray(st.variants) ? st.variants : []
  if (existing.some((v) => v.label === variant.label)) {
    throw new StoreError(400, `State "${stateId}" already has a variant labelled "${variant.label}".`)
  }
  st.variants = [...existing, variant]
  return []
}

/**
 * Edit ONE field of ONE variant arm.
 *
 * Until now the only way to change a B arm through the op vocabulary was to
 * remove it and add it back, which loses its position in the list — and the
 * player addresses an arm by `?variant=<label>`, so a rebuilt arm is a
 * different arm to anything holding a link to it. The editor's A/B control
 * always had this; the agent and the CLI did not.
 */
function opSetVariantField(
  w: StoredWorld,
  stateId: string,
  label: string,
  field: string,
  value: string,
): Diagnostic[] {
  const st = requireState(w, stateId)
  const list = Array.isArray(st.variants) ? st.variants : []
  const arm = list.find((v) => v.label === label)
  if (!arm) {
    throw new StoreError(400, `set_variant_field: state "${stateId}" has no variant labelled "${label}".`)
  }
  // The same flat vocabulary the state itself takes, so an author who knows how
  // to address `camera.static` on a state addresses it the same way on an arm.
  const patch = flatFieldPatch(arm, field, value, 'set_variant_field')
  checkStateFields(patch, `set_variant_field "${label}"`)
  mergePatch(arm, patch)
  return []
}

function opRemoveVariant(w: StoredWorld, stateId: string, index: number | null, variant: unknown): Diagnostic[] {
  const st = requireState(w, stateId)
  const list = Array.isArray(st.variants) ? [...st.variants] : []
  if (index !== null) {
    if (index < 0 || index >= list.length) throw new StoreError(400, `No variant at index ${index} on state "${stateId}".`)
    list.splice(index, 1)
  } else {
    const needle = JSON.stringify(variant)
    const at = list.findIndex((v) => JSON.stringify(v) === needle)
    if (at < 0) throw new StoreError(400, `That variant is not on state "${stateId}".`)
    list.splice(at, 1)
  }
  st.variants = list
  return []
}

// ─── Ops decoding ────────────────────────────────────────────────────────────

// The store's vocabulary IS the public one — derived, not restated. The hand-
// written list this replaced had drifted to nine names while the store applied
// nineteen, so the error a caller got when they mistyped an op named less than
// half of what they could have said.
const SUPPORTED_OPS = PUBLIC_OPS

/**
 * The op payload contract belongs to the hosted kernel, which is not in this
 * repository, so this accepts a documented superset of the plausible spellings:
 * the state id as `id`/`stateId`/`state`, the event name as `name`/`eventName`,
 * and a patch either nested under `patch` or spread inline. Anything it cannot
 * read is refused by name rather than silently skipped.
 */
/**
 * A FLAT field vocabulary — `base`, `camera.static`, `camera.dynamic`,
 * `movement.static`, `movement.dynamic` — as a patch this store can merge.
 *
 * Why the flat spelling exists at all: these ops are written by a language
 * model, and "set camera.static on state X to Y" is a shape a model gets right
 * far more often than a nested object it has to construct. The nesting is the
 * store's business, so it happens here, once.
 *
 * The patch is built against the CURRENT value rather than as a bare partial.
 * `checkStateFields` requires a camera/movement layer to be a complete
 * `{static, dynamic}` pair, and it is right to: a half-written layer reaches
 * the prompt assembler as an undefined line. Relaxing that check so a per-field
 * op could pass would weaken the boundary for every other op, so instead the
 * missing half is carried over from what the state already has.
 */
const FLAT_FIELDS = ['base', 'camera.static', 'camera.dynamic', 'movement.static', 'movement.dynamic'] as const

function flatFieldPatch(
  current: { camera?: { static: string; dynamic: string } | undefined; movement?: { static: string; dynamic: string } | undefined },
  field: string,
  value: string,
  at: string,
): Record<string, unknown> {
  if (!(FLAT_FIELDS as readonly string[]).includes(field)) {
    throw new StoreError(400, `${at}: "field" must be one of ${FLAT_FIELDS.join(', ')} — got "${field}".`)
  }
  if (typeof value !== 'string') {
    throw new StoreError(400, `${at}: "value" must be a string, got ${typeof value}.`)
  }
  const [head, leaf] = field.split('.')
  if (!leaf) return { [head as string]: value }
  const existing = head === 'camera' ? current.camera : current.movement
  return { [head as string]: { static: existing?.static ?? '', dynamic: existing?.dynamic ?? '', [leaf]: value } }
}

function opField(op: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = op[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

function opPatch(op: Record<string, unknown>, drop: string[]): Record<string, unknown> {
  if (isRecord(op["patch"])) return op["patch"]
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(op)) {
    if (k === 'op' || drop.includes(k)) continue
    out[k] = v
  }
  return out
}

function applyOne(w: StoredWorld, raw: PublicOp, index: number): Diagnostic[] {
  if (!isRecord(raw)) throw new StoreError(400, `ops[${index}] is not an object.`)
  // `raw`'s own type already carries an index signature (PublicOp is
  // `{ op: ... } & Record<string, unknown>`), so it IS the structural truth
  // the op functions below validate — no cast needed to read fields off it.
  const op = raw
  const kind = str(op["op"])
  const at = `ops[${index}] (${kind || 'no op name'})`

  switch (kind) {
    case 'add_state': {
      const body = isRecord(op["state"]) ? { ...op["state"] } : opPatch(op, ['id', 'stateId'])
      const id = opField(op, ['id', 'stateId'])
      return opAddState(w, { ...body, id: id || undefined })
    }
    case 'update_state': {
      const id = opField(op, ['id', 'stateId', 'state'])
      if (!id) throw new StoreError(400, `${at}: needs the state id.`)
      return opUpdateState(w, id, opPatch(op, ['id', 'stateId', 'state']))
    }
    case 'delete_state': {
      const id = opField(op, ['id', 'stateId', 'state'])
      if (!id) throw new StoreError(400, `${at}: needs the state id.`)
      return opDeleteState(w, id)
    }
    case 'add_event': {
      const body = isRecord(op["event"]) ? op["event"] : opPatch(op, [])
      return opAddEvent(w, body)
    }
    case 'update_event': {
      const name = opField(op, ['name', 'eventName', 'event'])
      if (!name) throw new StoreError(400, `${at}: needs the event name.`)
      return opUpdateEvent(w, name, opPatch(op, ['eventName', 'event', 'name']))
    }
    case 'add_mission': {
      // A mission COMPILES: the objectives become the states, events, flags and
      // endings the runtime already plays (`world/mission.ts`), and the record
      // is kept alongside for the quest panel. Applying it here rather than in
      // the caller means the agent, the CLI and the eDSL all get the same
      // mission from the same code.
      const spec = isRecord(op['mission']) ? op['mission'] : op
      const rawObjectives = spec['objectives']
      if (!Array.isArray(rawObjectives) || rawObjectives.length === 0) {
        throw new StoreError(400, 'add_mission: "objectives" must be a non-empty array.')
      }
      const objectives: SMObjective[] = rawObjectives.map((o, i) => {
        if (!isObjective(o)) {
          throw new StoreError(400, `add_mission: objective ${i + 1} needs at least an "id" and "text".`)
        }
        return o
      })
      const win = spec['win']
      const compiled = compileMission(w.world, {
        id: str(spec['id']),
        title: str(spec['title']),
        objectives,
        ...(isWin(win) ? { win } : {}),
        ...(typeof spec['complete'] === 'string' ? { complete: spec['complete'] } : {}),
        // The probe's own findings, carried onto the record. A field the schema
        // declares and the store drops is invisible — the op succeeds and the
        // evidence silently never lands.
        ...(Array.isArray(spec['verified'])
          ? { verified: spec['verified'].map((v) => str(v)).filter(Boolean) }
          : {}),
      })
      const out: Diagnostic[] = []
      for (const { id, state } of compiled.states) out.push(...opAddState(w, { id, ...state }))
      for (const event of compiled.events) out.push(...opAddEvent(w, { ...event }))
      for (const { id, ending } of compiled.endings) out.push(...opUpdateState(w, id, { ending }))
      w.world.missions = [...(w.world.missions ?? []), compiled.mission]
      return out
    }
    case 'set_intro': {
      const spec = isRecord(op['intro']) ? op['intro'] : op
      const video = spec['video']
      if (video !== undefined && video !== null && typeof video !== 'string') {
        throw new StoreError(400, 'set_intro: "video" must be a URL string, or null to remove it.')
      }
      const isStatic = spec['static'] ?? spec['introStatic']
      if (isStatic !== undefined && typeof isStatic !== 'boolean') {
        throw new StoreError(400, 'set_intro: "static" must be true or false — it says whether the clip ends still or mid-motion.')
      }
      if (video === null || video === '') delete w.world.introVideo
      else if (typeof video === 'string') w.world.introVideo = video
      if (typeof isStatic === 'boolean') w.world.introStatic = isStatic
      return []
    }
    case 'set_outro': {
      const spec = isRecord(op['outro']) ? op['outro'] : op
      if (spec['video'] === null) { delete w.world.outro; return [] }
      const video = str(spec['video']).trim()
      const flag = str(spec['flag']).trim()
      const state = str(spec['state']).trim()
      if (!video || !flag || !state) {
        throw new StoreError(400, 'set_outro: needs "video", the "flag" that earns it and the "state" it plays in.')
      }
      // The STATE has to exist: an outro condition naming a room the world does
      // not have can never come true, and nothing would ever say so.
      requireState(w, state)
      w.world.outro = { video, flag, state }
      return []
    }
    case 'set_narrate': {
      const on = isRecord(op) ? op['narrate'] : undefined
      if (typeof on !== 'boolean') throw new StoreError(400, 'set_narrate: "narrate" must be true or false.')
      // Written as an explicit false rather than deleted: "this author decided
      // not to" and "nobody has considered it" are different states, and only
      // the first should survive a round trip.
      w.world.narrate = on
      return []
    }
    case 'set_story': {
      const spec = isRecord(op['story']) ? op['story'] : op
      return opSetStory(w, spec)
    }
    case 'add_story_beat': {
      const spec = isRecord(op['beat']) ? op['beat'] : op
      return opAddStoryBeat(w, spec)
    }
    case 'add_cutscene': {
      const spec = isRecord(op['cutscene']) ? op['cutscene'] : op
      return opAddCutscene(w, spec)
    }
    case 'remove_cutscene': {
      const id = opField(op, ['id', 'cutsceneId', 'cutscene'])
      if (!id) throw new StoreError(400, `${at}: needs the cutscene id.`)
      return opRemoveCutscene(w, id)
    }
    case 'add_sequence': {
      const spec = isRecord(op['sequence']) ? op['sequence'] : op
      return opAddSequence(w, spec)
    }
    case 'remove_sequence': {
      const id = opField(op, ['id', 'sequenceId', 'sequence'])
      if (!id) throw new StoreError(400, `${at}: needs the sequence id.`)
      return opRemoveSequence(w, id)
    }
    case 'delete_event': {
      const name = opField(op, ['name', 'eventName', 'event'])
      if (!name) throw new StoreError(400, `${at}: needs the event name.`)
      return opDeleteEvent(w, name)
    }
    case 'set_entrance': {
      const entrance: Record<string, unknown> = isRecord(op["entrance"]) ? op["entrance"] : op
      return opSetEntrance(w, { state: opField(entrance, ['state', 'stateId', 'id']), image: entrance["image"] })
    }
    case 'add_variant': {
      const id = opField(op, ['id', 'stateId', 'state'])
      if (!id) throw new StoreError(400, `${at}: needs the state id.`)
      return opAddVariant(w, id, op["variant"])
    }
    case 'remove_variant': {
      const id = opField(op, ['id', 'stateId', 'state'])
      if (!id) throw new StoreError(400, `${at}: needs the state id.`)
      const index = typeof op["index"] === 'number' ? op["index"] : null
      if (index === null && op["variant"] === undefined) {
        throw new StoreError(400, `${at}: needs "index" or "variant".`)
      }
      return opRemoveVariant(w, id, index, op["variant"])
    }
    // ── The FINE-GRAINED vocabulary ────────────────────────────────────────
    //
    // Everything above is the coarse shape: `update_event` takes a patch of
    // any event fields at once, which is what an editor FORM wants — one
    // save, many fields. Below is the same work split into one narrow op per
    // concern, and that is the better vocabulary for the writer that matters
    // most here: the ops are emitted by a language model, and
    // `set_event_anchor {event, label}` is a shape a model gets right far
    // more often than a free-form patch. It also makes the action log
    // legible — `set_event_anchor` says what happened, `update_event` says
    // nothing without diffing the world before and after.
    //
    // So both exist, and neither reimplements the other: every case below
    // translates its narrow arguments into the same helper the coarse op calls.
    // A field that is dropped is dropped in ONE place, which is the only way
    // a dropped-field failure ("a field the schema carries and the store
    // drops is invisible") cannot come back through a second door.
    case 'set_field': {
      const id = opField(op, ['state', 'id', 'stateId'])
      if (!id) throw new StoreError(400, `${at}: needs the state id.`)
      const st = requireState(w, id)
      return opUpdateState(w, id, flatFieldPatch(st, str(op['field']), str(op['value']), at))
    }
    case 'set_event_field': {
      const name = opField(op, ['event', 'name', 'eventName'])
      if (!name) throw new StoreError(400, `${at}: needs the event name.`)
      const field = str(op['field'])
      if (field !== 'base' && field !== 'detail') {
        throw new StoreError(400, `${at}: "field" must be "base" or "detail" — got "${field}".`)
      }
      return opUpdateEvent(w, name, { [field]: str(op['value']) })
    }
    case 'add_transition': {
      return opAddEvent(w, { ...opPatch(op, []), kind: 'transition' })
    }
    case 'add_override': {
      // An override returns to the state it fired from, so it carries no `to`
      // — the doctrine's `dangling-ref` would flag one that did.
      return opAddEvent(w, { ...opPatch(op, ['to']), kind: 'override' })
    }
    case 'rename_state': {
      const from = opField(op, ['from', 'id', 'stateId'])
      // `to` is read RAW, not through opField: that helper trims a blank to ''
      // and the caller cannot tell "you left it out" from "you sent spaces".
      // The empty-id rule belongs to the rename, which says so precisely.
      const to = op['to'] ?? op['newId']
      if (!from || typeof to !== 'string') throw new StoreError(400, `${at}: needs "from" and "to".`)
      return opRenameState(w, from, to)
    }
    case 'remove_state': {
      const id = opField(op, ['id', 'stateId', 'state'])
      if (!id) throw new StoreError(400, `${at}: needs the state id.`)
      return opDeleteState(w, id)
    }
    case 'remove_event': {
      const name = opField(op, ['name', 'eventName', 'event'])
      if (!name) throw new StoreError(400, `${at}: needs the event name.`)
      return opDeleteEvent(w, name)
    }
    case 'set_state_ending': {
      const id = opField(op, ['state', 'id', 'stateId'])
      if (!id) throw new StoreError(400, `${at}: needs the state id.`)
      // `kind: null` clears the ending — the op that sets a thing is the op
      // that unsets it, rather than a second `clear_state_ending`.
      if (op['kind'] === null) return opUpdateState(w, id, { ending: null })
      const ending: Record<string, unknown> = { kind: str(op['kind']), title: str(op['title']) }
      if (typeof op['subtitle'] === 'string') ending['subtitle'] = op['subtitle']
      return opUpdateState(w, id, { ending })
    }
    case 'set_event_kind': {
      const name = opField(op, ['event', 'name', 'eventName'])
      if (!name) throw new StoreError(400, `${at}: needs the event name.`)
      const patch: Record<string, unknown> = { kind: str(op['kind']) }
      if (op['to'] !== undefined) patch['to'] = op['to']
      return opUpdateEvent(w, name, patch)
    }
    case 'set_event_drive': {
      const name = opField(op, ['event', 'name', 'eventName'])
      if (!name) throw new StoreError(400, `${at}: needs the event name.`)
      const drive: Record<string, unknown> = {}
      for (const k of ['movement', 'lookHorizontal', 'lookVertical']) {
        if (op[k] !== undefined) drive[k] = op[k]
      }
      const patch: Record<string, unknown> = { drive: Object.keys(drive).length > 0 ? drive : null }
      // The pulse lives on the event as `drivePulseMs`, not inside the drive
      // payload — and dropping it here would be exactly that kind of silent
      // loss.
      if (op['pulseMs'] !== undefined) patch['drivePulseMs'] = op['pulseMs']
      return opUpdateEvent(w, name, patch)
    }
    case 'set_event_hotkey': {
      const name = opField(op, ['event', 'name', 'eventName'])
      if (!name) throw new StoreError(400, `${at}: needs the event name.`)
      return opUpdateEvent(w, name, { hotkey: op['hotkey'] ?? null })
    }
    case 'set_event_phases': {
      const name = opField(op, ['event', 'name', 'eventName'])
      if (!name) throw new StoreError(400, `${at}: needs the event name.`)
      return opUpdateEvent(w, name, { phases: op['phases'] ?? null })
    }
    case 'set_event_anchor': {
      const name = opField(op, ['event', 'name', 'eventName'])
      if (!name) throw new StoreError(400, `${at}: needs the event name.`)
      if (op['label'] === null) return opUpdateEvent(w, name, { anchor: null })
      const anchor: Record<string, unknown> = { label: str(op['label']) }
      if (op['aliases'] !== undefined) anchor['aliases'] = op['aliases']
      if (op['minProximity'] !== undefined) anchor['minProximity'] = op['minProximity']
      if (op['expectedAspect'] !== undefined) anchor['expectedAspect'] = op['expectedAspect']
      return opUpdateEvent(w, name, { anchor })
    }
    case 'set_event_grants': {
      const name = opField(op, ['event', 'name', 'eventName'])
      if (!name) throw new StoreError(400, `${at}: needs the event name.`)
      return opUpdateEvent(w, name, { grants: op['grants'] ?? null })
    }
    case 'set_event_requires': {
      const name = opField(op, ['event', 'name', 'eventName'])
      if (!name) throw new StoreError(400, `${at}: needs the event name.`)
      return opUpdateEvent(w, name, { requires: op['requires'] ?? null })
    }
    case 'set_event_locked_hint': {
      const name = opField(op, ['event', 'name', 'eventName'])
      if (!name) throw new StoreError(400, `${at}: needs the event name.`)
      return opUpdateEvent(w, name, { lockedHint: op['hint'] ?? null })
    }
    case 'set_variant_field': {
      const id = opField(op, ['state', 'id', 'stateId'])
      const label = opField(op, ['label', 'variant', 'tag'])
      if (!id || !label) throw new StoreError(400, `${at}: needs the state id and the variant "label".`)
      return opSetVariantField(w, id, label, str(op['field']), str(op['value']))
    }
    case 'set_subject': {
      // The subject lock and its style tail live on the world, not the graph —
      // reachable until now only through the metadata update path, which the
      // agent and the CLI's `--ops` never touch.
      const patch: Record<string, unknown> = {}
      if (op['subject'] !== undefined) patch['subject'] = op['subject']
      if (op['styleTail'] !== undefined) patch['styleTail'] = op['styleTail']
      if (Object.keys(patch).length === 0) {
        throw new StoreError(400, `${at}: needs "subject" and/or "styleTail".`)
      }
      return opSetSubject(w, patch)
    }
    default:
      throw new StoreError(400, `${at}: unknown op. This store supports ${SUPPORTED_OPS.join(', ')}.`)
  }
}

// ─── The store ───────────────────────────────────────────────────────────────

const INFO: WorldStoreInfo = {
  id: 'local',
  label: 'This browser (offline)',
  local: true,
  checks: false,
  transfer: true,
}

export class LocalWorldStore implements WorldStore {
  readonly info = INFO

  private readonly storage: KeyValueStore
  private readonly backend: 'localStorage' | 'memory' | 'file'

  /** Pass a storage (the CLI's and the tests' file-backed driver) or leave it
   *  out for real browser localStorage. An injected store reports itself as
   *  'file' — it USED to claim 'localStorage', which made `world storage` in a
   *  terminal report a fabricated browser quota against a file on disk. */
  constructor(storage?: KeyValueStore) {
    if (storage) {
      this.storage = storage
      this.backend = 'file'
    } else {
      const resolved = resolveStorage()
      this.storage = resolved.storage
      this.backend = resolved.backend
    }
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  private read(): Db {
    const raw = this.storage.getItem(DB_KEY)
    if (raw === null || raw === '') return emptyDb()
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.quarantine(raw)
      return emptyDb()
    }
    if (!isRecord(parsed) || !Array.isArray(parsed["worlds"])) {
      this.quarantine(raw)
      return emptyDb()
    }
    return normalizeDb(parsed)
  }

  /**
   * Unreadable data is still data. Copy it somewhere a person can find it in
   * devtools before this store starts writing over the key; if the copy will not
   * fit, refuse to continue rather than trade their worlds for a working app.
   */
  private quarantine(raw: string): void {
    const key = `${DB_KEY}.corrupt-${Date.now()}`
    try {
      this.storage.setItem(key, raw)
    } catch {
      throw new StoreError(500,
        `Saved worlds under "${DB_KEY}" could not be read, and there is not enough room to copy them somewhere safe. ` +
        'Nothing has been changed. Open devtools → Application → Local Storage, save that value to a file, then clear it.')
    }
  }

  private write(db: Db): void {
    let json: string
    try {
      json = JSON.stringify(db)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      throw new StoreError(500, `Could not serialise worlds: ${message}`)
    }
    try {
      this.storage.setItem(DB_KEY, json)
    } catch (e) {
      if (isQuotaError(e)) throw this.quotaError(db, json)
      const message = e instanceof Error ? e.message : String(e)
      throw new StoreError(500, `Could not save to ${this.backend}: ${message}`)
    }
  }

  /** Read, mutate, write. Throwing anywhere leaves storage untouched. */
  private commit<T>(mutate: (db: Db) => T): T {
    const db = this.read()
    const out = mutate(db)
    this.write(db)
    return out
  }

  private quotaError(db: Db, json: string): StoreError {
    const usage = usageOf(db, json, this.backend)
    const worst = usage.worlds[0]
    const worstVersions = [...usage.worlds].sort((a, b) => b.versionBytes - a.versionBytes)[0]

    const lines = [
      `Out of browser storage. Nothing was saved and your worlds are unchanged (${fmtBytes(usage.bytes)} used, limit is about ${fmtBytes(ASSUMED_QUOTA_BYTES)}).`,
    ]
    if (worstVersions && worstVersions.versions > 0 && worstVersions.versionBytes > usage.bytes / 8) {
      lines.push(`"${worstVersions.name}" is holding ${worstVersions.versions} snapshot${worstVersions.versions === 1 ? '' : 's'} (${fmtBytes(worstVersions.versionBytes)}) — prune some in the Versions tab.`)
    }
    if (worst) {
      lines.push(`Largest world: "${worst.name}" at ${fmtBytes(worst.bytes)}. Export it, then delete it.`)
    }
    lines.push('A pasted cover image costs far more than a graph does. Export before you delete: these worlds exist only in this browser.')

    return new StoreError(507, lines.join(' '), { usage })
  }

  private find(db: Db, id: string): StoredWorld {
    const w = db.worlds.find((x) => x.id === id)
    if (!w) throw new StoreError(404, `No world "${id}" in this browser.`)
    return w
  }

  /** Shared prologue/epilogue for every graph write: find, check rev, bump rev.
   *
   *  `async`, not `Promise.resolve(this.commit(…))`. The commit runs
   *  synchronously either way, but written the old way its throws escaped
   *  SYNCHRONOUSLY out of a method whose type says it returns a promise — so a
   *  caller holding `store.applyOps(…).catch(…)` never saw a rev conflict, a
   *  rejected op, or the doctrine gate. Every caller in this repo happens to
   *  `await` inside a try, which is why nothing had noticed. */
  private async graphWrite(
    id: string,
    ifMatch: string | undefined,
    apply: (w: StoredWorld) => Diagnostic[],
  ): Promise<GraphWriteResult> {
    return this.commit((db) => {
      const w = this.find(db, id)
      assertRev(w, ifMatch)
      const diagnostics = apply(w)
      w.rev += 1
      w.updated_at = now()
      const res: GraphWriteResult = {
        world: clone(w.world),
        rev: String(w.rev),
        schemaVersion: LOCAL_SCHEMA_VERSION,
      }
      // Only attach diagnostics when the write actually produced some. An empty
      // array reads as "checked, all clear", which nothing here is entitled to say.
      if (diagnostics.length) res.diagnostics = diagnostics
      return res
    })
  }

  // ── Worlds lifecycle ─────────────────────────────────────────────────────

  async createWorld(body: CreateWorldBody, idempotencyKey?: string | undefined): Promise<CreateWorldResult> {
    return this.commit((db) => {
      const key = str(idempotencyKey).trim()
      if (key) {
        const seen = db.idem.find((e) => e.key === key)
        if (seen) {
          const existing = db.worlds.find((w) => w.id === seen.worldId)
          if (existing) {
            return { worldId: existing.id, slug: existing.slug ?? undefined, status: 'succeeded', schemaVersion: LOCAL_SCHEMA_VERSION }
          }
        }
      }

      const premise = str(body.premise).trim()
      const starter = body.template === 'starter'
      const quest = body.template === 'quest'
      const id = rid('w')
      const name = str(body.name).trim() || (quest ? QUEST_NAME : starter ? STARTER_NAME : premise.slice(0, 60) || 'Untitled world')
      const stamp = now()
      const built = quest ? questWorld() : null
      const scene = built ? built.scene : starter ? starterWorld() : blankScene(premise)
      const entranceState = quest ? 'alley' : starter ? 'lane' : 'opening'
      const cover = str(body.frame_b64)
        ? `data:image/png;base64,${body.frame_b64}`
        : str(body.frame_url) || null

      const world: SMWorld = {
        id,
        name,
        description: quest ? QUEST_DESCRIPTION : starter ? STARTER_DESCRIPTION : premise,
        cover,
        entrance: cover ? { state: entranceState, image: { src: cover } } : { state: entranceState },
        scene,
        // The quest example carries its mission RECORD and its subject lock: a
        // world with the graph but not the record is half a mission, and the
        // objective panel would have nothing to read.
        ...(built ? { missions: built.missions, subject: built.subject } : {}),
      }
      if (str(body.pov)) world["pov"] = str(body.pov)

      const record: StoredWorld = {
        id,
        name,
        description: quest ? QUEST_DESCRIPTION : starter ? STARTER_DESCRIPTION : premise,
        cover,
        visibility: 'private',
        slug: slugify(name),
        created_at: stamp,
        updated_at: stamp,
        rev: 1,
        headVersionId: null,
        world,
        versions: [],
      }
      db.worlds.push(record)

      if (key) {
        db.idem.push({ key, worldId: id })
        if (db.idem.length > IDEMPOTENCY_MEMORY) db.idem.splice(0, db.idem.length - IDEMPOTENCY_MEMORY)
      }

      // Never a jobId: there is no queue here, so creation has already happened
      // by the time this returns and the composer's job-polling path stays unused.
      return { worldId: id, slug: record.slug ?? undefined, status: 'succeeded', cover: cover ?? undefined, schemaVersion: LOCAL_SCHEMA_VERSION }
    })
  }

  async getJob(jobId: string): Promise<JobStatus> {
    throw new StoreError(404,
      `No job "${jobId}". Offline creation is synchronous — createWorld returns the world id itself and never a job to poll.`)
  }

  async listWorlds(params: ListParams = {}): Promise<WorldList> {
    const db = this.read()
    const limit = Math.max(1, Math.min(200, params.limit ?? DEFAULT_LIST_PAGE))
    const offset = decodeCursor(params.cursor)
    const ordered = [...db.worlds].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    const page = ordered.slice(offset, offset + limit)
    const next = offset + limit
    return {
      worlds: page.map(toListItem),
      nextCursor: next < ordered.length ? String(next) : null,
    }
  }

  async getWorld(id: string): Promise<WorldDocument> {
    const w = this.find(this.read(), id)
    return { ...clone(w.world), id: w.id, name: w.name, description: w.description, cover: w.cover, schemaVersion: LOCAL_SCHEMA_VERSION }
  }

  async updateWorld(id: string, patch: WorldPatch): Promise<WorldListItem & { schemaVersion: string }> {
    return this.commit((db) => {
      const w = this.find(db, id)
      if (patch.name !== undefined) {
        w.name = patch.name
        w.world.name = patch.name
        w.slug = slugify(patch.name)
      }
      if (patch.description !== undefined) {
        w.description = patch.description
        w.world.description = patch.description
      }
      if (patch.cover !== undefined) {
        w.cover = patch.cover
        w.world.cover = patch.cover
      }
      if (patch.visibility !== undefined) w.visibility = patch.visibility
      // The SUBJECT LOCK, as data. A world model draws a slightly different
      // creature every time it reads a slightly different subject, and prose is
      // where that drift hides — so the subject is stored once, on the world,
      // and the mission compiler reads it rather than guessing from a state.
      if (patch.subject !== undefined) w.world.subject = patch.subject
      if (patch.styleTail !== undefined) w.world.styleTail = patch.styleTail
      // Missions are world metadata beside the graph they compiled into: the
      // record the quest panel reads. Written here rather than through an op
      // because the graph half already went through `add_mission`.
      if (patch.missions !== undefined) w.world.missions = patch.missions
      w.updated_at = now()
      // Metadata is not the graph, so `rev` does not move: a rename must not
      // invalidate an editor's in-flight write.
      return { ...toListItem(w), schemaVersion: LOCAL_SCHEMA_VERSION }
    })
  }

  async deleteWorld(id: string): Promise<{ ok: boolean; deleted: string; brokeCampaigns?: string[] }> {
    return this.commit((db) => {
      this.find(db, id)
      // WHICH STORIES THIS BREAKS. A campaign is a macro-graph over worlds that
      // live here, so deleting one leaves an act pointing at nothing — the same
      // rot a deleted state leaves in a set-piece, and invisible for the same
      // reason: the reference was valid when it was written.
      //
      // Reported, not repaired. Pruning the act would silently rewrite someone's
      // story to hide their own deletion; the campaign's `act-has-world` lint
      // then refuses to play it until they decide what should happen instead.
      const broke = db.campaigns
        .filter((c) => c.graph.acts.some((a) => a.worldId === id))
        .map((c) => c.title)
      db.worlds = db.worlds.filter((w) => w.id !== id)
      db.idem = db.idem.filter((e) => e.worldId !== id)
      return broke.length > 0 ? { ok: true, deleted: id, brokeCampaigns: broke } : { ok: true, deleted: id }
    })
  }

  async forkWorld(id: string): Promise<{ worldId: string; schemaVersion: string }> {
    return this.commit((db) => {
      const src = this.find(db, id)
      const forkId = rid('w')
      const stamp = now()
      const name = `${src.name} (fork)`
      const world = clone(src.world)
      world.id = forkId
      world.name = name
      db.worlds.push({
        id: forkId,
        name,
        description: src.description,
        cover: src.cover,
        visibility: 'private',
        slug: slugify(name),
        created_at: stamp,
        updated_at: stamp,
        rev: 1,
        headVersionId: null,
        world,
        // Deliberately not copied: a fork is a new line of work, and duplicating
        // the whole snapshot history is the fastest way to fill a 5 MB budget.
        versions: [],
      })
      return { worldId: forkId, schemaVersion: LOCAL_SCHEMA_VERSION }
    })
  }

  // ── Graph ────────────────────────────────────────────────────────────────

  async getScene(id: string): Promise<SceneResult> {
    const w = this.find(this.read(), id)
    const sc = clone(sceneOf(w))
    return { states: sc.states, events: sc.events, rev: String(w.rev) }
  }

  addState(id: string, body: AddStateBody, ifMatch?: string | undefined): Promise<GraphWriteResult> {
    return this.graphWrite(id, ifMatch, (w) => opAddState(w, body))
  }

  updateState(id: string, stateId: string, patch: NullablePatch<SMState>, ifMatch?: string | undefined): Promise<GraphWriteResult> {
    return this.graphWrite(id, ifMatch, (w) => opUpdateState(w, stateId, patch))
  }

  deleteState(id: string, stateId: string, ifMatch?: string | undefined): Promise<GraphWriteResult> {
    return this.graphWrite(id, ifMatch, (w) => opDeleteState(w, stateId))
  }

  addEvent(id: string, body: AddEventBody, ifMatch?: string | undefined): Promise<GraphWriteResult> {
    // Spread into a fresh object literal: AddEventBody is a closed interface
    // with no index signature of its own, so this is the structural (no-cast)
    // way to hand it to a leaf that takes the store's structural truth.
    return this.graphWrite(id, ifMatch, (w) => opAddEvent(w, { ...body }))
  }

  updateEvent(id: string, name: string, patch: NullablePatch<SMEvent>, ifMatch?: string | undefined): Promise<GraphWriteResult> {
    return this.graphWrite(id, ifMatch, (w) => opUpdateEvent(w, name, patch))
  }

  deleteEvent(id: string, name: string, ifMatch?: string | undefined): Promise<GraphWriteResult> {
    return this.graphWrite(id, ifMatch, (w) => opDeleteEvent(w, name))
  }

  setEntrance(id: string, body: EntranceBody, ifMatch?: string | undefined): Promise<GraphWriteResult> {
    // Same reasoning as addEvent above: EntranceBody has no index signature.
    return this.graphWrite(id, ifMatch, (w) => opSetEntrance(w, { ...body }))
  }

  /**
   * All or nothing. Each op mutates the parsed copy in order; the first failure
   * throws out of commit() before it writes, so storage never sees a half-applied
   * batch and the caller's world is exactly as it was.
   */
  applyOps(
    id: string,
    ops: PublicOp[],
    ifMatch?: string | undefined,
    opts?: { strict?: boolean | undefined } | undefined,
  ): Promise<GraphWriteResult> {
    return this.graphWrite(id, ifMatch, (w) => {
      if (!Array.isArray(ops) || ops.length === 0) throw new StoreError(400, 'applyOps needs at least one op.')
      // The doctrine as it stands BEFORE this batch. Pre-existing errors are
      // not this batch's fault and must not be charged to it — see the gate.
      const before = opts?.strict ? errorKeys(runDoctrine(w.world)) : null
      const out: Diagnostic[] = []
      ops.forEach((op, i) => out.push(...applyOne(w, op, i)))
      if (before) assertNoNewErrors(before, w.world)
      return out
    })
  }

  // ── Checks ───────────────────────────────────────────────────────────────


  /**
   * The checks now RUN offline.
   *
   * They used to report unavailable, which was honest — the hosted authoring
   * kernel is not in this repository — but it meant a world authored entirely
   * offline never got so much as a dangling-reference check, and the studio's
   * own doctrine went unenforced on the only path a keyless user has. Most of
   * that doctrine needs no kernel: it is graph shape and text register, and it
   * lives in `../doctrine`.
   *
   * What is still hosted-only is narrower than "the checks": the lints that
   * need a rendered frame. Those are simply absent from the local catalogue
   * rather than reported as passing — the rule that governed this method when
   * it had nothing to report still holds.
   */
  async validate(id: string, world?: SMWorld): Promise<ValidateResult> {
    const target = world ?? unwrapWorldDoc(await this.getWorld(id))
    const diagnostics = runDoctrine(target).filter((d) => d.severity === 'error')
    return { available: true, ok: diagnostics.length === 0, diagnostics }
  }

  async lint(id: string, world?: SMWorld): Promise<LintResult> {
    const target = world ?? unwrapWorldDoc(await this.getWorld(id))
    const diagnostics = runDoctrine(target)
    return {
      available: true,
      ok: !diagnostics.some((d) => d.severity === 'error'),
      diagnostics,
      promptBudget: PROMPT_BUDGET,
    }
  }

  // ── Campaigns ────────────────────────────────────────────────────────────
  //
  // A campaign is a macro-graph over worlds that already exist here; it never
  // holds a copy of one. That is the whole reason it is stored beside the
  // worlds rather than inside a world: editing act two is editing a world, and
  // the campaign should not go stale because you did.

  async listCampaigns(): Promise<{ campaigns: Campaign[] }> {
    const db = this.read()
    return { campaigns: db.campaigns.map((c) => clone(c)) }
  }

  async getCampaign(id: string): Promise<Campaign> {
    const db = this.read()
    const found = db.campaigns.find((c) => c.id === id)
    if (!found) throw new StoreError(404, `No such campaign: ${id}.`)
    return clone(found)
  }

  /** Create or replace. The acts' worlds are checked to EXIST — an act pointing
   *  at a world this store cannot open is the campaign-level dangling ref, and
   *  it is cheaper to refuse it here than to discover it at the hand-off. */
  async saveCampaign(campaign: Campaign): Promise<Campaign> {
    return this.commit((db) => {
      for (const act of campaign.graph.acts) {
        if (!db.worlds.some((w) => w.id === act.worldId)) {
          throw new StoreError(400, `act "${act.actId}" points at a world this store does not have: ${act.worldId}.`)
        }
      }
      const at = now()
      const i = db.campaigns.findIndex((c) => c.id === campaign.id)
      const next: Campaign = {
        ...clone(campaign),
        created_at: i >= 0 ? db.campaigns[i]?.created_at ?? at : at,
        updated_at: at,
      }
      if (i >= 0) db.campaigns[i] = next
      else db.campaigns.push(next)
      return clone(next)
    })
  }

  async deleteCampaign(id: string): Promise<void> {
    return this.commit((db) => {
      const i = db.campaigns.findIndex((c) => c.id === id)
      if (i < 0) throw new StoreError(404, `No such campaign: ${id}.`)
      db.campaigns.splice(i, 1)
    })
  }

  /** The campaign's lints, run over the acts' CURRENT worlds — so a world edited
   *  after the campaign was written is judged as it is now, not as it was. */
  async lintCampaign(id: string): Promise<{ diagnostics: CampaignDiagnostic[]; ok: boolean }> {
    const campaign = await this.getCampaign(id)
    const worlds: Record<string, SMWorld> = {}
    for (const act of campaign.graph.acts) {
      const w = this.read().worlds.find((x) => x.id === act.worldId)
      if (w) worlds[act.actId] = w.world
    }
    const diagnostics = runCampaignLints(campaign.graph, worlds)
    return { diagnostics, ok: !campaignHasErrors(diagnostics) }
  }

  // ── Versions ─────────────────────────────────────────────────────────────

  async snapshotVersion(id: string, body: SnapshotBody = {}): Promise<{ versionId: string; version: VersionNode }> {
    return this.commit((db) => {
      const w = this.find(db, id)
      const versionId = rid('v')
      const parent = body.parentVersionId !== undefined ? body.parentVersionId : w.headVersionId
      const record: StoredVersion = {
        id: versionId,
        parentVersionId: parent && w.versions.some((v) => v.id === parent) ? parent : null,
        source: str(body.source, 'snapshot'),
        title: str(body.title).trim() || null,
        created_at: now(),
        snapshot: clone(w.world),
      }
      w.versions.push(record)
      w.headVersionId = versionId
      // A snapshot copies the graph, it does not change it, so `rev` holds still
      // and an editor mid-edit is not told to reload for nothing.
      return { versionId, version: toVersionNode(record) }
    })
  }

  async listVersions(id: string): Promise<{ versions: VersionNode[] }> {
    const w = this.find(this.read(), id)
    const versions = [...w.versions]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map(toVersionNode)
    return { versions }
  }

  async getVersion(id: string, versionId: string): Promise<{ id: string; snapshot: SMWorld }> {
    const w = this.find(this.read(), id)
    const v = w.versions.find((x) => x.id === versionId)
    if (!v) throw new StoreError(404, `No version "${versionId}" for this world.`)
    return { id: v.id, snapshot: clone(v.snapshot) }
  }

  async renameVersion(id: string, versionId: string, title: string): Promise<{ ok: boolean; versionId: string; title: string }> {
    return this.commit((db) => {
      const w = this.find(db, id)
      const v = w.versions.find((x) => x.id === versionId)
      if (!v) throw new StoreError(404, `No version "${versionId}" for this world.`)
      v.title = title.trim() || null
      return { ok: true, versionId, title: v.title ?? '' }
    })
  }

  async deleteVersion(id: string, versionId: string): Promise<{ ok: boolean; deleted: string }> {
    return this.commit((db) => {
      const w = this.find(db, id)
      const v = w.versions.find((x) => x.id === versionId)
      if (!v) throw new StoreError(404, `No version "${versionId}" for this world.`)
      if (w.headVersionId === versionId) {
        throw new StoreError(409, "Can't prune HEAD — this is the version the current graph came from. Snapshot again or check out another version first.")
      }
      // Re-parent the orphans onto the pruned node's parent so the tree stays a
      // tree; VersionsPanel indents by parent and would otherwise flatten them.
      for (const child of w.versions) {
        if (child.parentVersionId === versionId) child.parentVersionId = v.parentVersionId
      }
      w.versions = w.versions.filter((x) => x.id !== versionId)
      return { ok: true, deleted: versionId }
    })
  }

  async diffVersions(id: string, a: string, b: string): Promise<VersionDiff> {
    const w = this.find(this.read(), id)
    const left = w.versions.find((x) => x.id === a)
    const right = w.versions.find((x) => x.id === b)
    if (!left) throw new StoreError(404, `No version "${a}" for this world.`)
    if (!right) throw new StoreError(404, `No version "${b}" for this world.`)
    return {
      a,
      b,
      states: diffKeyed(left.snapshot.scene.states, right.snapshot.scene.states),
      events: diffKeyed(byName(left.snapshot.scene.events), byName(right.snapshot.scene.events)),
    }
  }

  async checkout(id: string, versionId: string, ifMatch?: string | undefined): Promise<{ world: SMWorld; rev: string }> {
    return this.commit((db) => {
      const w = this.find(db, id)
      assertRev(w, ifMatch)
      const v = w.versions.find((x) => x.id === versionId)
      if (!v) throw new StoreError(404, `No version "${versionId}" for this world.`)

      const restored = clone(v.snapshot)
      restored.id = w.id // identity belongs to the world, never to a snapshot
      w.world = restored
      w.name = str(restored.name) || w.name
      w.description = str(restored.description) || w.description
      w.cover = typeof restored.cover === 'string' ? restored.cover : w.cover
      w.headVersionId = versionId
      // Restoring old content is still a new revision. Anyone holding the rev
      // from before the checkout is stale and must be told so.
      w.rev += 1
      w.updated_at = now()
      return { world: clone(w.world), rev: String(w.rev) }
    })
  }

  // ── Storage ──────────────────────────────────────────────────────────────

  async usage(): Promise<StorageUsage> {
    const db = this.read()
    return usageOf(db, JSON.stringify(db), this.backend)
  }

  async exportWorlds(ids?: string[]): Promise<WorldsExport> {
    const db = this.read()
    const wanted = ids && ids.length ? db.worlds.filter((w) => ids.includes(w.id)) : db.worlds
    if (ids && ids.length) {
      const missing = ids.filter((id) => !db.worlds.some((w) => w.id === id))
      if (missing.length) throw new StoreError(404, `No world "${missing[0]}" in this browser.`)
    }
    return {
      format: 'alakazam-studio/worlds',
      version: 1,
      exportedAt: now(),
      worlds: wanted.map(toExported),
    }
  }

  async importWorlds(bundle: unknown, options: ImportOptions = {}): Promise<ImportResult> {
    const onConflict = options.onConflict ?? 'copy'
    if (!isRecord(bundle) || !Array.isArray(bundle["worlds"])) {
      throw new StoreError(400, 'That file is not a studio export. Expected a JSON object with a "worlds" array.')
    }
    if (bundle["format"] !== undefined && bundle["format"] !== 'alakazam-studio/worlds') {
      throw new StoreError(400, `Unknown export format "${String(bundle["format"])}".`)
    }
    const incoming = bundle["worlds"]

    return this.commit((db) => {
      const result: ImportResult = { imported: [], skipped: [] }
      for (let i = 0; i < incoming.length; i++) {
        const raw = incoming[i]
        if (!isRecord(raw)) {
          result.skipped.push({ id: `#${i}`, name: '', reason: 'not an object' })
          continue
        }
        const name = str(raw["name"]) || `Imported ${i + 1}`
        const sourceId = str(raw["id"])
        if (!isRecord(raw["world"]) && !isRecord(raw["scene"])) {
          result.skipped.push({ id: sourceId || `#${i}`, name, reason: 'no world graph in this entry' })
          continue
        }
        // An older or hand-rolled bundle may hold the SMWorld at the top level.
        const worldSource = isRecord(raw["world"]) ? raw["world"] : raw
        const clash = sourceId ? db.worlds.find((w) => w.id === sourceId) : undefined

        if (clash && onConflict === 'skip') {
          result.skipped.push({ id: sourceId, name, reason: 'already in this browser' })
          continue
        }
        const id = clash && onConflict === 'copy' ? rid('w') : sourceId || rid('w')
        const record = normalizeStoredWorld({ ...raw, id, world: worldSource, name }, db.worlds.length)
        record.updated_at = now()

        if (clash && onConflict === 'replace') {
          db.worlds = db.worlds.filter((w) => w.id !== sourceId)
          db.worlds.push(record)
          result.imported.push({ id, name: record.name, as: 'replaced' })
        } else {
          db.worlds.push(record)
          result.imported.push({ id, name: record.name, as: clash ? 'copy' : 'new' })
        }
      }
      // One write for the whole bundle: a quota failure imports nothing rather
      // than the first eleven worlds of twelve.
      return result
    })
  }
}

// ─── Free functions over stored shapes ───────────────────────────────────────

function assertRev(w: StoredWorld, ifMatch?: string | undefined): void {
  // No If-Match means last-write-wins, matching the hosted API where the header
  // is optional. The editor always sends one.
  if (!ifMatch) return
  const current = String(w.rev)
  if (ifMatch !== current) {
    throw new StoreError(409,
      `This world changed since the editor loaded it (you have rev ${ifMatch}, it is now rev ${current}). Reload and retry.`)
  }
}

function toListItem(w: StoredWorld): WorldListItem {
  return {
    id: w.id,
    name: w.name,
    description: w.description,
    cover: w.cover,
    visibility: w.visibility,
    slug: w.slug,
    updated_at: w.updated_at,
  }
}

function toVersionNode(v: StoredVersion): VersionNode {
  return { id: v.id, parentVersionId: v.parentVersionId, source: v.source, title: v.title, created_at: v.created_at }
}

function toExported(w: StoredWorld): ExportedWorld {
  return {
    id: w.id,
    name: w.name,
    description: w.description,
    cover: w.cover,
    visibility: w.visibility,
    slug: w.slug,
    created_at: w.created_at,
    updated_at: w.updated_at,
    world: clone(w.world),
    versions: w.versions.map((v) => ({ ...v, snapshot: clone(v.snapshot) })),
  }
}

function decodeCursor(cursor?: string | undefined): number {
  const n = Number(cursor)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function byName(events: SMEvent[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const ev of events) out[ev.name] = ev
  return out
}

/** Structural diff of two keyed collections. "changed" is JSON inequality. */
function diffKeyed(a: Record<string, unknown>, b: Record<string, unknown>) {
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const k of Object.keys(b)) if (!(k in a)) added.push(k)
  for (const k of Object.keys(a)) {
    if (!(k in b)) {
      removed.push(k)
      continue
    }
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) changed.push(k)
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() }
}

function usageOf(db: Db, json: string, backend: 'localStorage' | 'memory' | 'file'): StorageUsage {
  const worlds: WorldUsage[] = db.worlds.map((w) => {
    const versionBytes = byteLen(JSON.stringify(w.versions))
    return {
      id: w.id,
      name: w.name,
      bytes: byteLen(JSON.stringify(w)),
      versions: w.versions.length,
      versionBytes,
    }
  })
  worlds.sort((a, b) => b.bytes - a.bytes)
  return {
    backend,
    persistent: backend !== 'memory',
    bytes: byteLen(json),
    // A browser slot has a real (fuzzy) ceiling; a file on disk does not — the
    // doc on quotaBytes says null when the store is not the limiting factor.
    quotaBytes: backend === 'file' ? null : ASSUMED_QUOTA_BYTES,
    worlds,
    note:
      backend === 'memory'
        ? 'This browser refused localStorage (private mode, or storage disabled), so worlds are being kept in memory and WILL BE LOST when this tab closes. Export anything you want to keep.'
        : backend === 'file'
          ? 'Worlds live in a JSON file on this machine. Sizes here are UTF-8 bytes.'
          : 'Browsers do not agree on the localStorage limit or on how they measure it; about 5 MB is the common floor. Sizes here are UTF-8 bytes.',
  }
}
