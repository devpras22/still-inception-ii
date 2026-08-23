/**
 * RemoteWorldStore — the hosted path, unchanged.
 *
 * Every method here hands straight to the injected AlakazamClient, which keeps
 * its retry policy, its Idempotency-Key handling and the onCall hook that feeds
 * the API log. The client is injected rather than constructed so that the studio
 * keeps ONE client: build a second one here and half the requests would vanish
 * from the log panel while the user watched it.
 *
 * Two places where "thin" still means "translated":
 *
 *   · validate/lint return the WorldStore union. The hosted API signals an
 *     invalid world with a 422 whose body carries the diagnostics, which is a
 *     thrown ApiError in client-land; here it becomes { available: true,
 *     ok: false, diagnostics }. So the three real outcomes — could not check,
 *     checked and clean, checked and rejected — are three values rather than two
 *     values and an exception. Anything that is not a 422 still throws: a 500 or
 *     a dropped connection is not a verdict about the world.
 *
 *   · export/import refuse with 501. The hosted API is the source of truth for
 *     hosted worlds and has its own history; a bundle assembled here by fanning
 *     out over the REST surface would silently omit version snapshots, and a
 *     backup that is quietly incomplete is worse than no button. `info.transfer`
 *     is false so the UI can hide it rather than offer it and fail.
 */

import type { AlakazamClient } from '../api'
import type { Campaign, CampaignDiagnostic } from '../campaign'
import type { NullablePatch } from './types'
import type {
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
import {
  StoreError,
  type AddEventBody,
  type AddStateBody,
  type CreateWorldBody,
  type CreateWorldResult,
  type EntranceBody,
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
} from './types'

const INFO: WorldStoreInfo = {
  id: 'remote',
  label: 'Alakazam (hosted)',
  local: false,
  checks: true,
  transfer: false,
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** ApiError.diagnostics is unknown[] off the wire, so it is narrowed, not cast. */
function toDiagnostics(raw: unknown): Diagnostic[] {
  if (!Array.isArray(raw)) return []
  return raw.map((d): Diagnostic => {
    const o = isRecord(d) ? d : {}
    const sev = o["severity"]
    return {
      lint: typeof o["lint"] === 'string' ? o["lint"] : '',
      severity: sev === 'warning' || sev === 'info' ? sev : 'error',
      path: typeof o["path"] === 'string' ? o["path"] : '',
      message: typeof o["message"] === 'string' ? o["message"] : typeof d === 'string' ? d : JSON.stringify(d),
    }
  })
}

function statusOf(e: unknown): number | undefined {
  const s = isRecord(e) ? e["status"] : undefined
  return typeof s === 'number' ? s : undefined
}

export class RemoteWorldStore implements WorldStore {
  readonly info = INFO

  constructor(private readonly client: AlakazamClient) {}

  // ── Worlds lifecycle ─────────────────────────────────────────────────────

  createWorld(body: CreateWorldBody, idempotencyKey?: string | undefined): Promise<CreateWorldResult> {
    // `template` is a local-store concept; the hosted API generates from the
    // premise and has no use for it.
    const { template: _template, ...rest } = body
    return this.client.createWorld(rest, idempotencyKey)
  }

  getJob(jobId: string): Promise<JobStatus> {
    return this.client.getJob(jobId)
  }

  listWorlds(params: ListParams = {}): Promise<WorldList> {
    return this.client.listWorlds(params)
  }

  getWorld(id: string): Promise<WorldDocument> {
    return this.client.getWorld(id)
  }

  updateWorld(id: string, patch: WorldPatch): Promise<WorldListItem & { schemaVersion: string }> {
    return this.client.updateWorld(id, patch)
  }

  deleteWorld(id: string): Promise<{ ok: boolean; deleted: string }> {
    return this.client.deleteWorld(id)
  }

  forkWorld(id: string): Promise<{ worldId: string; schemaVersion: string }> {
    return this.client.forkWorld(id)
  }

  // ── Graph ────────────────────────────────────────────────────────────────

  getScene(id: string): Promise<SceneResult> {
    return this.client.getScene(id)
  }

  addState(id: string, body: AddStateBody, ifMatch?: string | undefined): Promise<GraphWriteResult> {
    return this.client.addState(id, body, ifMatch)
  }

  updateState(id: string, stateId: string, patch: NullablePatch<SMState>, ifMatch?: string | undefined): Promise<GraphWriteResult> {
    return this.client.updateState(id, stateId, patch, ifMatch)
  }

  deleteState(id: string, stateId: string, ifMatch?: string | undefined): Promise<GraphWriteResult> {
    return this.client.deleteState(id, stateId, ifMatch)
  }

  addEvent(id: string, body: AddEventBody, ifMatch?: string | undefined): Promise<GraphWriteResult> {
    return this.client.addEvent(id, body, ifMatch)
  }

  updateEvent(id: string, name: string, patch: NullablePatch<SMEvent>, ifMatch?: string | undefined): Promise<GraphWriteResult> {
    return this.client.updateEvent(id, name, patch, ifMatch)
  }

  deleteEvent(id: string, name: string, ifMatch?: string | undefined): Promise<GraphWriteResult> {
    return this.client.deleteEvent(id, name, ifMatch)
  }

  setEntrance(id: string, body: EntranceBody, ifMatch?: string | undefined): Promise<GraphWriteResult> {
    return this.client.setEntrance(id, body, ifMatch)
  }

  // ── Campaigns ────────────────────────────────────────────────────────────
  //
  // The hosted API has no campaign endpoints. Returning an empty list would read
  // as "you have no campaigns" — a green chip over nothing — so each of these
  // says what is actually true: this capability lives on the local store.
  private noCampaigns(): never {
    throw new StoreError(501, 'Campaigns are a local-store capability — the hosted API has no endpoint for them.')
  }

  async listCampaigns(): Promise<{ campaigns: Campaign[] }> { return this.noCampaigns() }
  async getCampaign(_id: string): Promise<Campaign> { return this.noCampaigns() }
  async saveCampaign(_c: Campaign): Promise<Campaign> { return this.noCampaigns() }
  async deleteCampaign(_id: string): Promise<void> { return this.noCampaigns() }
  async lintCampaign(_id: string): Promise<{ diagnostics: CampaignDiagnostic[]; ok: boolean }> { return this.noCampaigns() }

  /** `strict` is the LOCAL store's gate; the hosted service enforces its own at
   *  registration, so there is nothing to forward. */
  applyOps(id: string, ops: PublicOp[], ifMatch?: string | undefined, _opts?: { strict?: boolean | undefined } | undefined): Promise<GraphWriteResult> {
    return this.client.applyOps(id, ops, ifMatch)
  }

  // ── Checks ───────────────────────────────────────────────────────────────

  async validate(id: string, world?: SMWorld): Promise<ValidateResult> {
    try {
      const res = await this.client.validate(id, world)
      return { available: true, ok: res.ok !== false, diagnostics: toDiagnostics(res.diagnostics) }
    } catch (e) {
      if (statusOf(e) === 422) {
        const diagnostics = isRecord(e) ? e["diagnostics"] : undefined
        return { available: true, ok: false, diagnostics: toDiagnostics(diagnostics) }
      }
      throw e
    }
  }

  async lint(id: string, world?: SMWorld): Promise<LintResult> {
    const res = await this.client.lint(id, world)
    return {
      available: true,
      ok: res.ok !== false,
      diagnostics: toDiagnostics(res.diagnostics),
      promptBudget: res.promptBudget,
    }
  }

  // ── Versions ─────────────────────────────────────────────────────────────

  snapshotVersion(id: string, body: SnapshotBody = {}): Promise<{ versionId: string; version: VersionNode }> {
    return this.client.snapshotVersion(id, body)
  }

  listVersions(id: string): Promise<{ versions: VersionNode[] }> {
    return this.client.listVersions(id)
  }

  getVersion(id: string, versionId: string): Promise<{ id: string; snapshot: SMWorld }> {
    return this.client.getVersion(id, versionId)
  }

  renameVersion(id: string, versionId: string, title: string): Promise<{ ok: boolean; versionId: string; title: string }> {
    return this.client.renameVersion(id, versionId, title)
  }

  deleteVersion(id: string, versionId: string): Promise<{ ok: boolean; deleted: string }> {
    return this.client.deleteVersion(id, versionId)
  }

  diffVersions(id: string, a: string, b: string): Promise<VersionDiff> {
    return this.client.diffVersions(id, a, b)
  }

  checkout(id: string, versionId: string, ifMatch?: string | undefined): Promise<{ world: SMWorld; rev: string }> {
    return this.client.checkout(id, versionId, ifMatch)
  }

  // ── Storage ──────────────────────────────────────────────────────────────

  /** Not the account's API usage — see the note in types.ts. */
  async usage(): Promise<StorageUsage> {
    return {
      backend: 'remote',
      persistent: true,
      bytes: 0,
      quotaBytes: null,
      worlds: [],
      note: 'Worlds are stored by the hosted API, so this browser holds none of them and no local quota applies.',
    }
  }

  async exportWorlds(_ids?: string[]): Promise<WorldsExport> {
    throw new StoreError(501,
      'Export is a local-store feature. Hosted worlds live on the API, which owns their version history — ' +
      'fetch them from /v1 rather than from this browser.')
  }

  async importWorlds(_bundle: unknown): Promise<ImportResult> {
    throw new StoreError(501,
      'Import is a local-store feature. To put a bundle into a hosted account, create the worlds through /v1 ' +
      'so the API assigns ids and history rather than trusting ids from a file.')
  }
}
