/**
 * Probe selection — the discrimination core that turns raw per-variant boxes
 * into verified grounding targets.
 *
 * The probe fans a handful of candidate objects out to a vision model, one
 * `detect()` call per NAME VARIANT (a curator proposes several alternate
 * nouns for the same physical thing, because an open-vocabulary detector is
 * fussy about exact wording — "door" may hit where "wooden door" misses).
 * Turning those raw per-variant boxes into "which objects can the author
 * safely ground an anchor on" is pure geometry, no I/O, and it is the part
 * that makes grounding trustworthy rather than a coin flip on whichever
 * variant happened to return a box first.
 *
 * Four steps:
 *
 *   ANCHOR   — cluster a candidate's own hit boxes by greedy IoU clustering
 *     (`_CLUSTER_IOU`); the densest cluster's largest box is the object's
 *     true location. This is what stops one promiscuous variant dragging a
 *     stray box on some other object into the answer: the real object gets
 *     hit by MANY variants (a dense cluster), a stray hit by one or two.
 *   MERGE    — candidates whose anchors coincide (`_MERGE_IOU`) are the SAME
 *     physical object the curator named twice; union their variants into
 *     one entry rather than reporting it twice.
 *   DISCRIMINATE — a variant is PROMISCUOUS if any of its boxes lands on a
 *     DIFFERENT verified object's anchor (`_COLLIDE_IOU`) — it doesn't
 *     discriminate this object from its neighbour, so it is rejected. The
 *     primary label is the best-anchor-coverage NON-promiscuous variant;
 *     other clean variants become aliases.
 *   DROP     — an object with no non-promiscuous variant is dropped
 *     entirely: we could not find a label that points only at it, so the
 *     author never sees it and cannot build an undetectable action.
 *
 * Then, MEASURED never author-supplied: `expectedAspect` (bbox aspect-ratio
 * bounds) only when the object collided with another — shape as
 * belt-and-suspenders where labels alone might still confuse a wrong-shaped
 * neighbour — and `minProximity` only for genuinely thin objects (aspect
 * ratio < 0.55 or > 1.8), whose short axis never grows large even up close,
 * so the default proximity floor would never arm.
 */

import type { DetectedBox } from '../types'

/**
 * One curated object as a small group of alternate plain-noun variants —
 * the input shape a curate stage produces, and this selection algorithm was
 * written against. Each variant carries every box the vision model returned
 * for it against the probed frame (empty when that variant missed).
 */
export interface ProbeCandidate {
  label: string
  variants: { label: string; boxes: DetectedBox[] }[]
}

/**
 * One object the probe verified — safe to hand to the author as a grounding
 * target. `label` is the discriminating PRIMARY detect label (not
 * necessarily the candidate's own proposed name); `aliases` are the other
 * variants that also hit cleanly. `anchor` and `hits` are measured, never
 * guessed.
 */
export interface VerifiedObject {
  label: string
  aliases: string[]
  anchor: DetectedBox
  /** How many boxes (across every variant) landed in the winning anchor
   *  cluster — the evidence behind this object's location. */
  hits: number
  /** bbox aspect-ratio bounds; present only when this object collided with
   *  another. */
  expectedAspect?: { min: number; max: number }
  /** present only for genuinely thin objects. */
  minProximity?: number
}

// ─── Tunables ──────────────────────────────────────────────────────────────

/** Two boxes are "the same region" above this IoU — used both to cluster a
 *  candidate's own variant boxes (find its true anchor) and to merge
 *  duplicate candidates the curator proposed for one object. */
const _CLUSTER_IOU = 0.30
const _MERGE_IOU = 0.70
/** A variant's box "lands on" another object's anchor above this IoU → the
 *  variant is promiscuous (matches more than its own object). */
const _COLLIDE_IOU = 0.40
/** A clean variant must cover its own anchor at least this well — named
 *  here because it is read twice below. */
const _CLEAN_COVER_MIN = 0.2

// ─── Geometry primitives ──────────────────────────────────────────────────

/** 0..1 normalised box area. Degenerate (non-positive) spans clamp to zero
 *  rather than going negative. */
export function area(b: DetectedBox): number {
  return Math.max(0, b.xMax - b.xMin) * Math.max(0, b.yMax - b.yMin)
}

/** Intersection-over-union of two 0..1 normalised boxes. */
export function iou(a: DetectedBox, b: DetectedBox): number {
  const ix0 = Math.max(a.xMin, b.xMin)
  const iy0 = Math.max(a.yMin, b.yMin)
  const ix1 = Math.min(a.xMax, b.xMax)
  const iy1 = Math.min(a.yMax, b.yMax)
  const iw = Math.max(0, ix1 - ix0)
  const ih = Math.max(0, iy1 - iy0)
  const inter = iw * ih
  if (inter <= 0) return 0
  const union = area(a) + area(b) - inter
  return union > 0 ? inter / union : 0
}

export interface Cluster {
  boxes: DetectedBox[]
  /** The cluster's largest box — its representative. */
  rep: DetectedBox
}

/**
 * Greedy IoU clustering: each box
 * joins the first cluster whose representative overlaps it above
 * `_CLUSTER_IOU`, else starts a new cluster. The representative is kept as
 * the cluster's largest box, so a cluster's `rep` only ever grows more
 * confident as more corroborating boxes join it.
 */
export function cluster(boxes: DetectedBox[]): Cluster[] {
  const clusters: Cluster[] = []
  for (const b of boxes) {
    let placed = false
    for (const c of clusters) {
      if (iou(b, c.rep) > _CLUSTER_IOU) {
        c.boxes.push(b)
        if (area(b) > area(c.rep)) c.rep = b
        placed = true
        break
      }
    }
    if (!placed) clusters.push({ boxes: [b], rep: b })
  }
  return clusters
}

/** Heuristic confidence: big + low-in-frame reads as near/important. Used
 *  only as the tiebreaker when two clean variants cover the anchor equally
 *  well. */
function boxConf(b: DetectedBox): number {
  return Math.max(0, Math.min(1, area(b) * 0.7 + (b.yMax - 0.5) * 0.6))
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

// ─── Selection core ─────────────────────────────────────────────────────────

interface Working {
  variants: Map<string, DetectedBox[]>
  anchor: DetectedBox | undefined
  hits: number
  merged: boolean
}

interface Anchored extends Working {
  anchor: DetectedBox
}

function hasAnchor(w: Working): w is Anchored {
  return w.anchor !== undefined
}

/** ANCHOR: pool every variant's boxes, cluster them, and hand back the
 *  densest cluster's largest box plus how many boxes support it. `undefined`
 *  when the candidate hit nothing at all — it never reaches the merge/
 *  discriminate steps below, which is the same as being dropped. */
function anchorOf(variants: Map<string, DetectedBox[]>): { anchor: DetectedBox; hits: number } | undefined {
  const all: DetectedBox[] = []
  for (const boxes of variants.values()) all.push(...boxes)
  if (all.length === 0) return undefined
  let best: Cluster | undefined
  for (const c of cluster(all)) {
    const better =
      !best || c.boxes.length > best.boxes.length || (c.boxes.length === best.boxes.length && area(c.rep) > area(best.rep))
    if (better) best = c
  }
  if (!best) return undefined
  return { anchor: best.rep, hits: best.boxes.length }
}

/**
 * The pure discrimination core. Given each candidate's measured variant
 * boxes, choose a discriminating primary label per object, demote clean
 * synonyms to aliases, reject promiscuous labels, merge duplicate
 * candidates, and drop indistinct objects entirely.
 */
export function selectVerifiedObjects(candidates: ProbeCandidate[]): VerifiedObject[] {
  const working: Working[] = candidates.map((c) => {
    const variants = new Map<string, DetectedBox[]>()
    for (const v of c.variants) variants.set(v.label, v.boxes.slice())
    const anchored = anchorOf(variants)
    return { variants, anchor: anchored ? anchored.anchor : undefined, hits: anchored ? anchored.hits : 0, merged: false }
  })

  // MERGE: candidates whose anchors coincide are the
  // SAME physical object the curator named twice — union the later
  // candidate's variants into the earlier survivor and tombstone it.
  for (let i = 0; i < working.length; i += 1) {
    const wi = working[i]
    if (!wi || wi.merged || wi.anchor === undefined) continue
    const anchorI = wi.anchor
    for (let j = i + 1; j < working.length; j += 1) {
      const wj = working[j]
      if (!wj || wj.merged || wj.anchor === undefined) continue
      if (iou(anchorI, wj.anchor) <= _MERGE_IOU) continue
      wj.merged = true
      wi.hits += wj.hits
      for (const [label, boxes] of wj.variants) {
        const existing = wi.variants.get(label)
        wi.variants.set(label, existing ? existing.concat(boxes) : boxes.slice())
      }
    }
  }

  const live = working.filter((w) => !w.merged).filter(hasAnchor)
  const results: VerifiedObject[] = []

  for (const w of live) {
    const otherAnchors = live.filter((o) => o !== w).map((o) => o.anchor)
    const scored: { variant: string; promiscuous: boolean; cover: number; conf: number }[] = []

    for (const [variant, boxes] of w.variants) {
      if (boxes.length === 0) continue
      let bestBox: DetectedBox | undefined
      let bestCover = -1
      for (const b of boxes) {
        const cov = iou(b, w.anchor)
        if (cov > bestCover) {
          bestCover = cov
          bestBox = b
        }
      }
      if (!bestBox) continue
      // DISCRIMINATE: promiscuous when this variant
      // ALSO lands on a different verified object's anchor.
      const promiscuous = otherAnchors.some((oa) => boxes.some((b) => iou(b, oa) > _COLLIDE_IOU))
      scored.push({ variant, promiscuous, cover: bestCover, conf: boxConf(bestBox) })
    }

    const clean = scored.filter((s) => !s.promiscuous && s.cover > _CLEAN_COVER_MIN)
    const collided = scored.some((s) => s.promiscuous) || otherAnchors.some((oa) => iou(w.anchor, oa) > _COLLIDE_IOU)

    // DROP: no non-promiscuous, well-covering variant
    // survived — this object never reaches the caller.
    if (clean.length === 0) continue

    // Primary = best anchor coverage, confidence as the tiebreaker; the rest
    // of the clean set become aliases.
    clean.sort((a, b) => b.cover - a.cover || b.conf - a.conf)
    const primary = clean[0]
    if (!primary) continue
    const aliases = clean.slice(1).map((s) => s.variant)

    const width = w.anchor.xMax - w.anchor.xMin
    const height = w.anchor.yMax - w.anchor.yMin
    const ratio = height > 0 ? width / height : 1.0
    const short = Math.min(width, height)
    const thin = ratio < 0.55 || ratio > 1.8

    results.push({
      label: primary.variant,
      aliases,
      anchor: w.anchor,
      hits: w.hits,
      ...(collided ? { expectedAspect: { min: round3(ratio * 0.5), max: round3(ratio * 1.9) } } : {}),
      ...(thin ? { minProximity: round3(Math.max(0.07, Math.min(0.16, short * 1.4))) } : {}),
    })
  }

  return results
}
