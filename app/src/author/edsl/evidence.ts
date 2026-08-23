import type { SMLandWhen } from '../../world'
import { hitEvents, specFromLandWhen } from '../../play'
import type { EpisodeRecord, EvidenceSpec } from '../../play'

/**
 * Stagecraft layer 2 — evidence, the contract algebra.
 *
 * This is the layer that carries Outlines' core move across to a world model.
 * Outlines compiles a contract once and makes invalid output UNSAMPLABLE; you
 * cannot mask a diffusion model's pixels, so the contract moves from
 * constrained decoding to VERIFIED LANDING — an evidence spec compiled into
 * the runtime's `landWhen` check (`play/evidence.ts`). Same philosophy, applied
 * after the fact: it guarantees observable structure, never that a world is
 * any good.
 *
 * It is also Guidance's `select()` over sub-grammars, made legible. There, the
 * model emits and the PARSE of what came out decides which branch you are in.
 * Here the pixels decide: `until: see.bright(70).hits(2)` is a branch chosen by
 * what the picture shows.
 *
 * Builders are immutable — every method returns a new value. The runtime's
 * `landWhen` is ONE clause object whose enabled clauses OR, so `either()`
 * MERGES clause objects, and merging two different values for the same field
 * is a COMPILE ERROR: the shape simply cannot represent it, and discovering
 * that at author time is the entire point of the layer.
 */

export type LandWhen = SMLandWhen

export class EvidenceError extends Error {}

export class Evidence {
  readonly fields: Readonly<LandWhen>

  constructor(fields: LandWhen) {
    this.fields = Object.freeze({ ...fields })
  }

  private with(patch: Partial<LandWhen>): Evidence {
    return new Evidence(mergeFields(this.fields, patch))
  }

  /** Cumulative passing ticks required before landing (runtime default 1). */
  hits(n: number): Evidence {
    return this.with({ hits: n })
  }

  /** Fail-open ceiling in ms (runtime default 20s). */
  within(ms: number): Evidence {
    return this.with({ timeoutMs: ms })
  }

  /**
   * Trigger-zone mode: the same evidence also completes the transition during
   * free roam, with no press. The runtime honours it for PIXEL evidence only,
   * and the `auto-needs-pixels` lint enforces that at compile time rather than
   * letting an author discover a zone that silently never fires.
   */
  auto(): Evidence {
    return this.with({ auto: true })
  }

  toLandWhen(): LandWhen {
    return { ...this.fields }
  }

  /**
   * The clause set alone, for replaying this evidence over a RECORDED session
   * (`play/episode.ts`).
   *
   * `hits`, `timeoutMs` and `auto` are deliberately absent: they say how a LIVE
   * gate is spent, not what counts as evidence.
   */
  toEvidenceSpec(): EvidenceSpec {
    return specFromLandWhen(this.fields)
  }
}

/**
 * Offline recognition: replay this evidence over a session that already
 * happened. No model, no GPU, no frame generated.
 *
 * This is Guidance's `grammar.match` in the place a world model leaves for it.
 * You cannot mask a diffusion model's pixels, so the contract became VERIFIED
 * LANDING — and the other half of a contract you can verify is a contract you
 * can REPLAY: an author asks whether the zone they just wrote would have fired
 * during the session they just played, and gets a time rather than an opinion.
 */
export function matches(
  evidence: Evidence,
  record: EpisodeRecord,
  fromMs = 0,
): { hits: number[]; passed: boolean } {
  const events = hitEvents(record, evidence.toEvidenceSpec(), fromMs)
  return { hits: events, passed: events.length >= (evidence.fields.hits ?? 1) }
}

/** Merge two clause sets, refusing any field that would need two values.
 *  Built field by field off the declared shape rather than by casting a bag of
 *  unknowns — the conflict check is the whole reason this function exists, and
 *  it should not be reachable through a type hole. */
function mergeFields(a: Readonly<LandWhen>, b: Partial<LandWhen>): LandWhen {
  const out: LandWhen = { ...a }
  const take = <K extends keyof LandWhen>(key: K): void => {
    const value = b[key]
    if (value === undefined || value === null) return
    const existing = out[key]
    if (existing !== undefined && existing !== null && !sameValue(existing, value)) {
      throw new EvidenceError(
        `evidence merge conflict on '${String(key)}': ${JSON.stringify(existing)} vs ${JSON.stringify(value)} — ` +
          'landWhen holds ONE value per clause, so this contract cannot be represented',
      )
    }
    out[key] = value
  }
  take('label'); take('aliases'); take('minExtent')
  take('minLuminance'); take('maxLuminance')
  take('minMotion'); take('maxMotion')
  take('hits'); take('timeoutMs'); take('auto')
  return out
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i])
  }
  return a === b
}

/** The clause constructors. Each names what the PICTURE has to show. */
export const see = {
  /** Mean frame luminance must EXCEED n — the dark→bright arrival. */
  bright(n: number): Evidence {
    return new Evidence({ minLuminance: n })
  },
  /** Mean frame luminance must stay UNDER n — the bright→dark mirror. */
  dim(n: number): Evidence {
    return new Evidence({ maxLuminance: n })
  },
  /** Inter-sample motion must EXCEED n — the signature of travelling. */
  moving(n: number): Evidence {
    return new Evidence({ minMotion: n })
  },
  /** Inter-sample motion must DROP UNDER n — the signature of arriving. */
  still(n: number): Evidence {
    return new Evidence({ maxMotion: n })
  },
  /** A detected object, filling at least `minExtent` of the frame. Leaving
   *  `minExtent` off is what the `sliver-evidence` lint warns about: a strip of
   *  the thing at the frame edge would count. */
  a(label: string, opts: { aliases?: string[]; minExtent?: number } = {}): Evidence {
    return new Evidence({
      label,
      ...(opts.aliases ? { aliases: [...opts.aliases] } : {}),
      ...(opts.minExtent !== undefined ? { minExtent: opts.minExtent } : {}),
    })
  },
}

/**
 * OR two or more clauses. The runtime already ORs the clauses inside one
 * `landWhen`, so this is a MERGE — and a merge that cannot be represented
 * (two `minLuminance` values) throws here, at author time, instead of
 * silently keeping one of them.
 */
export function either(...parts: Evidence[]): Evidence {
  let out: LandWhen = {}
  for (const part of parts) out = mergeFields(out, part.fields)
  return new Evidence(out)
}
