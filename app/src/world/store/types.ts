/**
 * WorldStore — where a world actually lives.
 *
 * The studio's third seam, and the one that decides whether this repository is a
 * program or a brochure. Both other seams already work without an account: the
 * mock world model draws without a key, and the LLM axis reaches anything that
 * speaks OpenAI's API. Storage did not. Every world operation went through the
 * hosted /v1 API, so a person who cloned this repo and opened it could look at
 * the studio and touch none of it.
 *
 * So: one interface, two implementations.
 *
 *   LocalWorldStore   localStorage. No key, no network, no account. The default.
 *   RemoteWorldStore  the hosted /v1 API, unchanged, for people who want it.
 *
 * The shape below is DERIVED FROM AlakazamClient, method by method, so the swap
 * is a drop-in rather than a rewrite of every component. Three deliberate
 * departures, each because pretending would be worse than differing:
 *
 *   1. `validate`/`lint` return a discriminated union with an `available` flag.
 *      The authoring kernel that implements those checks is not in this
 *      repository. Offline they return { available: false, reason }, which the
 *      UI renders as "cannot check here" — never as "no problems found". A clean
 *      bill of health from a check that never ran is the worst output this
 *      studio could produce, so the type system forbids expressing it.
 *
 *   2. `usage()` reports BROWSER STORAGE, not the account's API usage. It shares
 *      a name with AlakazamClient.usage() (day/usage/caps, consumed by
 *      Account.tsx) and means something entirely different. That endpoint is an
 *      account concern and is deliberately absent from this interface; anything
 *      needing it should keep talking to AlakazamClient directly.
 *
 *   3. `exportWorlds`/`importWorlds` exist only because a store with no way out
 *      is a trap. Worlds in local mode live in one browser profile, and a
 *      profile is one "clear site data" away from gone.
 *
 * Not here at all, because they are not storage: session minting and embed URLs
 * (the world-model axis), seed-frame painting and the hosted agent edit (the LLM
 * axis), vision/grounding, and account usage. See docs for the full gap list.
 */

import type { Campaign, CampaignDiagnostic } from '../campaign'
import type {
  SMMission,
  Diagnostic,
  GraphWriteResult,
  PublicOp,
  SMEvent,
  SMState,
  SMWorld,
  VersionNode,
  WorldList,
  WorldListItem,
} from '../types'
import type { ApiError } from '../types'

/**
 * Stamped onto everything the local store returns. The hosted API's
 * `schemaVersion` describes the kernel's world schema and only the kernel can
 * mint it, so offline we return a store-owned tag rather than guessing at a
 * number that would later be compared against a real one.
 */
export const LOCAL_SCHEMA_VERSION = 'offline/1'

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Structurally an ApiError, because the components already branch on `.status`
 * and read `.detail`, and offline behaviour that needs its own error handling is
 * not a drop-in. The status codes are the HTTP ones the hosted API would return
 * for the same situation:
 *
 *   400  malformed request (unknown op, duplicate id, unknown state)
 *   404  no such world / state / event / version
 *   409  optimistic-concurrency conflict, or pruning HEAD
 *   500  storage unreadable or unwritable for a reason that is not quota
 *   501  not implemented by this store (see `WorldStoreInfo`)
 *   507  out of browser storage — nothing was written
 */
export class StoreError extends Error implements ApiError {
  readonly status: number
  readonly detail: string
  readonly diagnostics?: unknown[] | undefined
  /** Present on 507 so the UI can render what is taking up the space. */
  readonly usage?: StorageUsage | undefined

  constructor(status: number, detail: string, extra: { diagnostics?: unknown[] | undefined; usage?: StorageUsage | undefined } = {}) {
    super(detail)
    this.name = 'StoreError'
    this.status = status
    this.detail = detail
    this.diagnostics = extra.diagnostics
    this.usage = extra.usage
  }
}

// ─── Worlds ──────────────────────────────────────────────────────────────────

export interface CreateWorldBody {
  premise?: string | undefined
  name?: string | undefined
  pov?: string | undefined
  frame_b64?: string | undefined
  frame_url?: string | undefined
  async?: boolean | undefined
  /**
   * Local only. 'starter' lays down a small authored world so a new user has
   * something to drive; anything else lays down one entrance state seeded from
   * the premise. The hosted API generates a world from the premise instead and
   * never sees this field — RemoteWorldStore strips it.
   */
  template?: 'blank' | 'starter' | 'quest' | undefined
}

export interface CreateWorldResult {
  worldId?: string | undefined
  slug?: string | undefined
  jobId?: string | undefined
  status?: string | undefined
  cover?: string | undefined
  schemaVersion: string
}

export interface JobStatus {
  jobId: string
  status: string
  phase?: string | undefined
  progress?: number | undefined
  worldId?: string | undefined
  error?: string | undefined
}

export interface WorldPatch {
  name?: string | undefined
  description?: string | undefined
  cover?: string | undefined
  visibility?: string | undefined
  /** The subject lock, as DATA rather than as prose repeated in every state —
   *  what the mission compiler names when it writes a resting scene. */
  subject?: string | undefined
  /** The closing atmosphere line every state ends on. */
  styleTail?: string | undefined
  /** The quest records beside the graph they compiled into. */
  missions?: SMMission[] | undefined
}

export interface ListParams {
  limit?: number | undefined
  cursor?: string | undefined
}

/** getWorld's shape: the world itself, with the hosted API's optional envelope. */
export type WorldDocument = SMWorld & { world?: SMWorld | undefined; schemaVersion: string }

/**
 * Flatten getWorld's result to the world itself. The hosted API wraps the world
 * in an envelope and the local store does not; every reader used to know that
 * fact privately (two had already hand-rolled the unwrap, with casts). The store
 * owns its own wire shape, so the one place that knowledge lives is here.
 */
export function unwrapWorldDoc(doc: WorldDocument): SMWorld {
  return doc.world ?? doc
}

// ─── Graph ───────────────────────────────────────────────────────────────────

export interface SceneResult {
  states: Record<string, SMState>
  events: SMEvent[]
  rev: string
}

export type AddStateBody = { id?: string | undefined } & Partial<SMState>

/**
 * A field-level patch where `null` ERASES and `undefined` leaves alone.
 *
 * `Partial<SMState>` could only ever set or keep, which made every optional
 * field a one-way switch in the UI: you could mark a state as an ending and
 * never unmark it, because "off" had no representation on the wire. The store's
 * merge has always treated null as a delete; only the type disagreed.
 */
export type NullablePatch<T> = { [K in keyof T]?: T[K] | null }

export interface AddEventBody {
  kind: 'transition' | 'override'
  from: string | string[]
  to?: string | undefined
  name?: string | undefined
  base?: string | undefined
  detail?: string | undefined
  hotkey?: string | null | undefined
}

export interface EntranceBody {
  state: string
  image?: { label?: string | undefined; src: string } | undefined
}

// ─── Checks ──────────────────────────────────────────────────────────────────

/**
 * The honest answer when the check cannot run at all. `reason` is written for a
 * person, not a log: it says what is missing and what would fix it.
 */
export interface CheckUnavailable {
  available: false
  reason: string
}

export interface ValidateReport {
  available: true
  /** false = the fail-closed gate rejected this world; `diagnostics` say why. */
  ok: boolean
  diagnostics: Diagnostic[]
}

export interface LintReport {
  available: true
  ok: boolean
  diagnostics: Diagnostic[]
  promptBudget: number
}

export type ValidateResult = ValidateReport | CheckUnavailable
export type LintResult = LintReport | CheckUnavailable

// ─── Versions ────────────────────────────────────────────────────────────────

export interface SnapshotBody {
  title?: string | undefined
  parentVersionId?: string | null | undefined
  source?: string | undefined
}

export interface DiffGroup {
  added: string[]
  removed: string[]
  changed: string[]
}

export interface VersionDiff {
  a: string
  b: string
  states: DiffGroup
  events: DiffGroup
}

// ─── Storage accounting ──────────────────────────────────────────────────────

export interface WorldUsage {
  id: string
  name: string
  /** Total bytes for this world: graph, cover, and all its snapshots. */
  bytes: number
  versions: number
  /** How much of `bytes` is version snapshots — usually the thing to prune. */
  versionBytes: number
}

/**
 * Browser-storage accounting. NOT AlakazamClient.usage(), which reports the
 * account's daily API usage against its caps; see the note at the top of this
 * file.
 */
export interface StorageUsage {
  backend: 'localStorage' | 'memory' | 'file' | 'remote'
  /** False means the worlds die with the tab, and the UI must say so. */
  persistent: boolean
  bytes: number
  /** Best-effort ceiling. null when the store is not the limiting factor. */
  quotaBytes: number | null
  /** Largest first, so "what do I delete" is answered by reading downward. */
  worlds: WorldUsage[]
  note?: string | undefined
}

// ─── Export / import ─────────────────────────────────────────────────────────

export interface ExportedVersion {
  id: string
  parentVersionId: string | null
  source: string
  title: string | null
  created_at: string
  snapshot: SMWorld
}

export interface ExportedWorld {
  id: string
  name: string
  description: string
  cover: string | null
  visibility: string
  slug: string | null
  created_at: string
  updated_at: string
  world: SMWorld
  versions: ExportedVersion[]
}

export interface WorldsExport {
  format: 'alakazam-studio/worlds'
  version: 1
  exportedAt: string
  worlds: ExportedWorld[]
}

export interface ImportOptions {
  /**
   * What to do when an incoming world has an id already in the store.
   * 'copy' (the default) keeps both under a fresh id — importing must never be
   * the thing that destroys a world.
   */
  onConflict?: 'copy' | 'skip' | 'replace' | undefined
}

export interface ImportResult {
  imported: { id: string; name: string; as: 'new' | 'copy' | 'replaced' }[]
  skipped: { id: string; name: string; reason: string }[]
}

// ─── The store ───────────────────────────────────────────────────────────────

/** What this implementation can do. Read it to decide what to render. */
export interface WorldStoreInfo {
  id: 'local' | 'remote'
  label: string
  /** Worlds exist only in this browser profile. Clearing site data loses them. */
  local: boolean
  /** validate()/lint() can genuinely run. False → both report unavailable. */
  checks: boolean
  /** exportWorlds()/importWorlds() are implemented. */
  transfer: boolean
}

/**
 * Every world operation the studio's components perform, in the hosted client's
 * own signatures. `ifMatch` is the optimistic-concurrency rev from `getScene` or
 * a prior write; pass it and a stale write is rejected with 409, exactly as the
 * hosted API does, so the editor's conflict path behaves identically online and
 * off. Omit it and last-write-wins, also as the hosted API does.
 */
export interface WorldStore {
  readonly info: WorldStoreInfo

  // Worlds lifecycle
  createWorld(body: CreateWorldBody, idempotencyKey?: string | undefined): Promise<CreateWorldResult>
  getJob(jobId: string): Promise<JobStatus>
  listWorlds(params?: ListParams): Promise<WorldList>
  getWorld(id: string): Promise<WorldDocument>
  updateWorld(id: string, patch: WorldPatch): Promise<WorldListItem & { schemaVersion: string }>
  /** `brokeCampaigns` names the stories whose acts pointed at this world — the
   *  delete still happens, and the caller is told what it cost. */
  deleteWorld(id: string): Promise<{ ok: boolean; deleted: string; brokeCampaigns?: string[] | undefined }>
  forkWorld(id: string): Promise<{ worldId: string; schemaVersion: string }>

  // Graph read
  getScene(id: string): Promise<SceneResult>

  // Graph write
  addState(id: string, body: AddStateBody, ifMatch?: string | undefined): Promise<GraphWriteResult>
  updateState(id: string, stateId: string, patch: NullablePatch<SMState>, ifMatch?: string | undefined): Promise<GraphWriteResult>
  deleteState(id: string, stateId: string, ifMatch?: string | undefined): Promise<GraphWriteResult>
  addEvent(id: string, body: AddEventBody, ifMatch?: string | undefined): Promise<GraphWriteResult>
  updateEvent(id: string, name: string, patch: NullablePatch<SMEvent>, ifMatch?: string | undefined): Promise<GraphWriteResult>
  deleteEvent(id: string, name: string, ifMatch?: string | undefined): Promise<GraphWriteResult>
  setEntrance(id: string, body: EntranceBody, ifMatch?: string | undefined): Promise<GraphWriteResult>
  applyOps(id: string, ops: PublicOp[], ifMatch?: string | undefined, opts?: { strict?: boolean | undefined } | undefined): Promise<GraphWriteResult>

  // Campaigns — several worlds joined into one story. The hosted API has no
  // endpoint for these, so its adapter says so rather than pretending.
  listCampaigns(): Promise<{ campaigns: Campaign[] }>
  getCampaign(id: string): Promise<Campaign>
  saveCampaign(campaign: Campaign): Promise<Campaign>
  deleteCampaign(id: string): Promise<void>
  lintCampaign(id: string): Promise<{ diagnostics: CampaignDiagnostic[]; ok: boolean }>

  // Checks — see CheckUnavailable
  validate(id: string, world?: SMWorld): Promise<ValidateResult>
  lint(id: string, world?: SMWorld): Promise<LintResult>

  // Versions
  snapshotVersion(id: string, body?: SnapshotBody | undefined): Promise<{ versionId: string; version: VersionNode }>
  listVersions(id: string): Promise<{ versions: VersionNode[] }>
  getVersion(id: string, versionId: string): Promise<{ id: string; snapshot: SMWorld }>
  renameVersion(id: string, versionId: string, title: string): Promise<{ ok: boolean; versionId: string; title: string }>
  deleteVersion(id: string, versionId: string): Promise<{ ok: boolean; deleted: string }>
  diffVersions(id: string, a: string, b: string): Promise<VersionDiff>
  checkout(id: string, versionId: string, ifMatch?: string | undefined): Promise<{ world: SMWorld; rev: string }>

  // Storage
  usage(): Promise<StorageUsage>
  /** Omit `ids` for everything. The bundle is complete: graphs and snapshots. */
  exportWorlds(ids?: string[]): Promise<WorldsExport>
  /** `bundle` is untrusted file input and is validated field by field. */
  importWorlds(bundle: unknown, options?: ImportOptions): Promise<ImportResult>
}
