/**
 * Local doctrine — the offline-runnable slice of the full SMWorld/SMEvent lint
 * doctrine. The real gate lives in a hosted kernel this repository does not
 * vendor, so `LocalWorldStore` has always reported `validate()`/`lint()` as
 * UNAVAILABLE — see that file's doc comment. That was honest, not useless, but
 * it meant a world authored entirely offline never got so much as a
 * dangling-reference check. This file is the part of the doctrine that needs no
 * LLM, no vision model and no hosted kernel to run at all: graph-shape checks
 * over `scene.states`/`scene.events`, plus three text-register lints
 * (negation/whiteout/budget) whose regexes and severities are a fixed, tested
 * rule set rather than a fresh judgment call.
 *
 * Three rules once thought unportable have since become portable, and are now
 * here: `unreachable-require` (the `requires`/`grants` algebra — the fields were
 * always on `SMEvent`), `lethal-override` (narrowed to a regex over override
 * prose, the SAME basis negation/whiteout are on — a pinned keyword list, under
 * test, not a judgment made here), and `sliver-evidence`, which maps onto this
 * fork's own vocabulary: the studio gates the play-time chip on
 * `anchor.minProximity` (`play/anchors.ts`), and an anchor without one is the
 * same defect either way — a sliver at the frame edge counts, so the chip arms
 * from across the room.
 *
 * The schema then grew `phases` and `landWhen` — authored, stored, and RUN by
 * `play/` — so three more rules came with them: `shared-phase-camera`,
 * `auto-needs-pixels`, `luminance-overlap`. This is a mechanical, pinned rule
 * set, not a redesign of one — see `negationHits`/`whiteoutHits` below for why
 * they are named for what they mechanically do, not what they mean.
 *
 * `runDoctrine` is pure and total: it never throws, and it trusts its input at
 * the type it already declares (an `SMWorld`'s own interiors), exactly as every
 * other reader in this domain does — see `narrow.ts`'s doc comment on why deep
 * interiors stay untouched at the boundary. This is graph/regex checking over
 * already-typed data, not a second parser.
 */

import type { Diagnostic, SMState, SMWorld } from './types'
import { missionGrounding } from './mission'

/** The assembled-prompt char ceiling every doctrine site agrees on — past this
 *  the kernel truncates silently. */
export const PROMPT_BUDGET = 1900

const NEGATION_RE = /\b(?:no|not|never|without|none|nothing|don'?t|doesn'?t|can'?t|won'?t)\b/i
const WHITEOUT_RE = /\b(?:white-?out|blinding|blown[- ]?white|bloom(?:ed|ing)?|over-?exposed|washed[- ]?out)\b/i
// Lethal vocabulary: kill / shoot / gun down / execute / lying on the ground.
// Deliberately NOT bare 'dead' / 'shot' / 'corpse' — "dead neon" and "a wide
// shot" are ordinary scene prose and must never false-error an override.
const LETHAL_RE =
  /\b(?:kill(?:s|ed|ing)?|shoot(?:s|ing)?|guns? (?:him|her|them|the \w+) down|gunned down|execut(?:e|es|ed|ion)|lying on the ground)\b/i

/** Build one diagnostic. Shared with the store, which raises its own (cascade
 *  warnings, refused ops) in the same shape — one domain, one constructor. */
export function diag(lint: string, severity: Diagnostic['severity'], path: string, message: string): Diagnostic {
  return { lint, severity, path, message }
}

// ─── Structural lints ────────────────────────────────────────────────────────
// Graph-shape facts only: every check below is a reachability/reference question
// answerable from scene.states/scene.events alone, with no prose involved.

/**
 * `dangling-ref` (error) — an event's `from`/`to` names a state that is not in
 * `scene.states`. Deliberately narrow in scope: unknown `entrance.state` and
 * duplicate ids get their own ids below (`no-entrance`, `entrance-missing-state`)
 * so each diagnostic points at exactly the field that is wrong, rather than one
 * lint id covering three unrelated shapes of mistake.
 */
function danglingRefHits(world: SMWorld): Diagnostic[] {
  const states = world.scene.states
  const cutsceneIds = new Set((world.cutscenes ?? []).map((c) => c.id))
  const out: Diagnostic[] = []
  for (const ev of world.scene.events) {
    for (const from of ev.from) {
      if (!(from in states)) {
        out.push(diag('dangling-ref', 'error', `events.${ev.name}.from`,
          `Event "${ev.name}" names "${from}" in "from", but no such state exists.`))
      }
    }
    // A destination is a state OR a cutscene: the runtime resolves a
    // transition's `to` against cutscene ids first. A rule that knew only about
    // states would call every authored cut a dangling reference — and since the
    // player refuses to open a world with doctrine errors, an authored cutscene
    // would have made the world unplayable.
    if (ev.to !== undefined && !(ev.to in states) && !cutsceneIds.has(ev.to)) {
      out.push(diag('dangling-ref', 'error', `events.${ev.name}.to`,
        `Event "${ev.name}" points "to" "${ev.to}", but no state or cutscene has that id.`))
    }
  }
  return out
}

/** `transition-needs-to` (error) — a held transition with nowhere to land does
 *  nothing when it releases. Overrides are exempt by construction: they always
 *  return to the state they fired from, so an absent `to` on an override is the
 *  correct shape, not a violation. */
function transitionNeedsToHits(world: SMWorld): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const ev of world.scene.events) {
    if (ev.kind === 'transition' && !ev.to) {
      out.push(diag('transition-needs-to', 'error', `events.${ev.name}.to`,
        `Event "${ev.name}" is a transition but has no "to" — releasing it lands nowhere.`))
    }
  }
  return out
}

/** `no-entrance` (error) — a world that already has states but nothing marking
 *  where a player starts cannot be opened. An empty world (no states yet) is not
 *  a violation of this rule — there is nothing to enter regardless of entrance. */
function noEntranceHits(world: SMWorld): Diagnostic[] {
  if (Object.keys(world.scene.states).length === 0) return []
  if (world.entrance) return []
  return [diag('no-entrance', 'error', 'entrance', 'This world has states but no entrance — it cannot be opened.')]
}

/** `entrance-missing-state` (error) — the entrance names a state that does not
 *  exist in `scene.states`. */
function entranceMissingStateHits(world: SMWorld): Diagnostic[] {
  const entrance = world.entrance
  if (!entrance) return []
  if (entrance.state in world.scene.states) return []
  return [diag('entrance-missing-state', 'error', 'entrance.state',
    `Entrance names state "${entrance.state}", but no such state exists.`)]
}

/**
 * `unreachable-state` (warning) — no chain of `to`-carrying events reaches this
 * state from the entrance. An `override` event never advances state (it always
 * returns to the state it fired from, by construction — see
 * `transitionNeedsToHits` above), so only edges that carry a `to` count as
 * movement; that is the runtime's own held-transition semantic, not a
 * graph-theory default chosen here. Skipped entirely when the entrance itself is
 * missing or invalid — that is already `no-entrance`/`entrance-missing-state`
 * above, and "unreachable from nowhere" is not a second fact worth a warning.
 */
function unreachableStateHits(world: SMWorld): Diagnostic[] {
  const states = world.scene.states
  const start = world.entrance?.state
  if (start === undefined || !(start in states)) return []

  // A transition may name a CUTSCENE as its `to` — the runtime resolves the
  // cut and lands in the cut's own `to` (see `resolveDestination`). The walk
  // must hop through the cut or every branch behind a clip reads as stranded,
  // which is exactly where a choice film keeps all of its states.
  const cutById = new Map((world.cutscenes ?? []).map((c) => [c.id, c]))
  const edges = new Map<string, string[]>()
  for (const ev of world.scene.events) {
    if (!ev.to) continue
    const cut = cutById.get(ev.to)
    const dest = cut ? cut.to : ev.to
    if (!(dest in states)) continue
    for (const from of ev.from) {
      const list = edges.get(from)
      if (list) list.push(dest)
      else edges.set(from, [dest])
    }
  }

  const seen = new Set<string>([start])
  const stack = [start]
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    for (const next of edges.get(id) ?? []) {
      if (!seen.has(next)) {
        seen.add(next)
        stack.push(next)
      }
    }
  }

  return Object.keys(states)
    .filter((id) => !seen.has(id))
    .map((id) => diag('unreachable-state', 'warning', `states.${id}`,
      `No path of transitions from the entrance reaches "${id}".`))
}

/** `no-ending` (warning) — nothing in the world marks a stopping point. One
 *  world-level diagnostic, not one per state: the fact being reported is about
 *  the world as a whole having nowhere to stop, not any single state's shape. */
function noEndingHits(world: SMWorld): Diagnostic[] {
  const hasEnding = Object.values(world.scene.states).some((st) => st.ending !== undefined)
  if (hasEnding) return []
  return [diag('no-ending', 'warning', 'scene.states', 'No state carries an "ending" — this world has nowhere to stop.')]
}

/** `orphan-event` (error) — an event with no source state can never fire. */
function orphanEventHits(world: SMWorld): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const ev of world.scene.events) {
    if (ev.from.length === 0) {
      out.push(diag('orphan-event', 'error', `events.${ev.name}.from`,
        `Event "${ev.name}" has an empty "from" — it has no state to fire in and can never trigger.`))
    }
  }
  return out
}

// ─── Text-register lints ─────────────────────────────────────────────────────
// Mechanical regex matches, pinned by tests — NOT meaning-inference. Named for
// what they mechanically do (find a regex hit) rather than what they judge, per
// this domain's no-encoded-judgment convention: taste comes from a model, never
// from a keyword list standing in for one. These two ARE a keyword list, but a
// fixed one, reproduced under test, not a decision made here.

/** One negation-regex hit report, reused by every content-register field below. */
function negationHits(text: string, path: string): Diagnostic[] {
  const m = NEGATION_RE.exec(text)
  if (!m) return []
  return [diag('negation', 'error', path,
    `content prose contains negation '${m[0]}' — the model renders what it reads ("NOT a rotor" summons a rotor); rephrase positively.`)]
}

/** One whiteout-regex hit report, reused by the transition-scope fields below. */
function whiteoutHits(text: string, path: string): Diagnostic[] {
  const m = WHITEOUT_RE.exec(text)
  if (!m) return []
  return [diag('whiteout', 'error', path,
    `transition prose contains '${m[0]}' — a blown-white frame is ambiguous evidence the model resolves BACKWARD (the step-outside rollback); keep continuous spatial anchors instead.`)]
}

/**
 * `negation` — content-register prose only. Camera fields are EXEMPT: negative
 * view-locks are the proven camera doctrine, so `state.camera` is deliberately
 * never passed to `negationHits` below, and that omission IS the exemption, not
 * an oversight.
 */
function negationLints(world: SMWorld): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const [id, st] of Object.entries(world.scene.states)) {
    out.push(...negationHits(st.base, `states.${id}.base`))
    if (st.movement) {
      out.push(...negationHits(st.movement.static, `states.${id}.movement.static`))
      out.push(...negationHits(st.movement.dynamic, `states.${id}.movement.dynamic`))
    }
    ;(st.ambient ?? []).forEach((line, i) => {
      out.push(...negationHits(line, `states.${id}.ambient[${i}]`))
    })
    // st.camera is intentionally never checked here — see the doc comment above.
  }
  for (const ev of world.scene.events) {
    if (ev.base) out.push(...negationHits(ev.base, `events.${ev.name}.base`))
    if (ev.detail) out.push(...negationHits(ev.detail, `events.${ev.name}.detail`))
  }
  return out
}

/**
 * `whiteout` — transition-event/phase scope only. `override`/`terminal` events
 * are not scanned: a sustained override returns to the unchanged state on
 * release, so a whiteout word there is not the backward-resolving ambiguity
 * this lint exists to catch.
 */
function whiteoutLints(world: SMWorld): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const ev of world.scene.events) {
    if (ev.kind !== 'transition') continue
    if (ev.base) out.push(...whiteoutHits(ev.base, `events.${ev.name}.base`))
    if (ev.detail) out.push(...whiteoutHits(ev.detail, `events.${ev.name}.detail`))
  }
  return out
}

/** The text the `budget` lint measures for one state: base + camera + movement
 *  + ambient, joined — see `budgetLints` below for exactly what this assembles
 *  and why. */
function assembleStateText(st: SMState): string {
  const parts: string[] = [st.base]
  if (st.camera) parts.push(st.camera.static, st.camera.dynamic)
  if (st.movement) parts.push(st.movement.static, st.movement.dynamic)
  if (st.ambient) parts.push(...st.ambient)
  return parts.filter((s) => s.length > 0).join(' ')
}

/**
 * `budget` (error) — the fully ASSEMBLED per-state prompt, not any one field:
 * checked on the fully assembled prompt string, not per-field. This checks one
 * combined string per state (both layer variants plus ambient together) because
 * the `SMState`/`SMEvent` shapes here (`api.ts`) carry no phase/variant
 * machinery to assemble against events at all — see this file's header comment
 * on scope.
 */
function budgetLints(world: SMWorld): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const [id, st] of Object.entries(world.scene.states)) {
    const assembled = assembleStateText(st)
    if (assembled.length > PROMPT_BUDGET) {
      out.push(diag('budget', 'error', `states.${id}`,
        `assembled prompt is ${assembled.length} chars (budget ${PROMPT_BUDGET}) — the kernel truncates silently.`))
    }
  }
  return out
}

// ─── The public face ─────────────────────────────────────────────────────────

/**
 * Runs every local doctrine rule and returns every hit, errors and warnings
 * together. A caller that needs only the fail-closed subset filters by
 * `severity === 'error'` — see `store/local.ts`'s `validate`/`lint`, which
 * share the same diagnostics but differ in what blocks.
 */
/**
 * `unreachable-require` (error) — an event gated on a flag that NOTHING grants.
 *
 * A locked door with no key anywhere in the world. The player reaches the
 * state, sees nothing offered, and there is no sequence of moves that would
 * ever change that — which reads to them as the world being broken, because
 * it is.
 */
function unreachableRequireHits(world: SMWorld): Diagnostic[] {
  const granted = new Set<string>()
  for (const ev of world.scene.events) for (const g of ev.grants ?? []) granted.add(g)
  const out: Diagnostic[] = []
  for (const ev of world.scene.events) {
    for (const need of ev.requires ?? []) {
      if (!granted.has(need)) {
        out.push(diag('unreachable-require', 'error', `events.${ev.name}.requires`,
          `Event "${ev.name}" requires the flag "${need}", which no event ever grants — it can never fire.`))
      }
    }
  }
  return out
}

/**
 * `lethal-override` (error) — a death the world takes back.
 *
 * An override returns to the state it fired in when it ends, so anything killed
 * inside one resurrects the moment it finishes. This narrows the check to a
 * fixed lethal vocabulary rather than trying to judge violence: kill / shoot /
 * gun down / execute / lying on the ground, deliberately NOT bare "dead" or
 * "shot" ("dead neon", "a wide shot" are ordinary scene prose and must not
 * false-error an override).
 */
function lethalOverrideHits(world: SMWorld): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const ev of world.scene.events) {
    if (ev.kind !== 'override') continue
    for (const [field, text] of [['base', ev.base], ['detail', ev.detail]] as const) {
      if (!text) continue
      const m = LETHAL_RE.exec(text)
      if (!m) continue
      out.push(diag('lethal-override', 'error', `events.${ev.name}.${field}`,
        `override prose contains '${m[0]}' — an override snaps back to the state it fired in, so whoever dies here comes back to life; make it a transition into a changed state.`))
    }
  }
  return out
}

/**
 * `sliver-evidence` (warning) — an anchored interaction with no minimum size.
 *
 * The studio gates the play-time chip on `anchor.minProximity`
 * (`play/anchors.ts`): with no minimum, a sliver of the object at the frame
 * edge counts as "the player is at it", so the chip arms from across the room
 * and the action resolves on something the camera is nowhere near.
 *
 * A warning, not an error, and for a specific reason: the authoring probe only
 * MEASURES `minProximity` for genuinely thin objects (`provider/vision/probe.ts`),
 * so a wide anchor legitimately has none. This is the panel's one auto-fixable
 * lint (`lintHelp.ts`) precisely because the fix is a single safe number rather
 * than a judgment.
 */
function sliverEvidenceHits(world: SMWorld): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const ev of world.scene.events) {
    const anchor = ev.anchor
    if (!anchor?.label) continue
    if (anchor.minProximity !== undefined) continue
    out.push(diag('sliver-evidence', 'warning', `events.${ev.name}.anchor`,
      `Event "${ev.name}" is anchored to "${anchor.label}" with no minimum on-screen size — a sliver at the frame edge counts, so it arms from across the room.`))
  }
  return out
}

/**
 * `shared-phase-camera` (warning) — one camera narrating a whole sequence.
 *
 * The reason phases exist at all: a camera saying "as he steps out" appended to
 * phase 1 teleports the model straight to the ending of the move. Every stage
 * must describe ONLY its own reality, so a multi-phase event that leans on the
 * event-level camera for stages that have none is telling the model the end of
 * the story at the start of it.
 */
function sharedPhaseCameraHits(world: SMWorld): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const ev of world.scene.events) {
    const phases = ev.phases
    if (!phases || phases.length < 2) continue
    const bare = phases.filter((p) => !p.camera?.trim()).length
    if (bare === 0) continue
    out.push(diag('shared-phase-camera', 'warning', `events.${ev.name}.phases`,
      `Event "${ev.name}" runs ${phases.length} phases and ${bare} of them have no camera of their own — they share one, which narrates the end of the move during its first beat.`))
  }
  return out
}

/**
 * `auto-needs-pixels` (error) — a trigger zone with nothing to watch.
 *
 * `auto` means the transition ALSO completes during free roam, with no press.
 * The runtime honors that for the free per-tick signals only (`play/evidence.ts`
 * `autoEligible`): luminance and motion are unambiguous and cost nothing, while
 * a label is neither — a road being visible does not mean you are driving down
 * it. An auto gate carrying only a label is a zone that silently never fires,
 * which reads to a player as a world that is simply broken.
 */
function autoNeedsPixelsHits(world: SMWorld): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const ev of world.scene.events) {
    const lw = ev.landWhen
    if (!lw?.auto) continue
    const pixels =
      lw.minLuminance !== undefined || lw.maxLuminance !== undefined ||
      lw.minMotion !== undefined || lw.maxMotion !== undefined
    if (pixels) continue
    out.push(diag('auto-needs-pixels', 'error', `events.${ev.name}.landWhen`,
      `Event "${ev.name}" is a trigger zone but carries no luminance or motion evidence — the runtime honors auto for those signals only, so this zone would never fire.`))
  }
  return out
}

/**
 * `luminance-overlap` (error) — two triggers that fight each other.
 *
 * A forward zone that lands on BRIGHT paired with its reverse landing on DIM
 * oscillates whenever the bands overlap: the player crosses, the reverse
 * immediately qualifies, and the world flips back and forth on its own. Only a
 * genuine round trip counts as a pair (each event's source is the other's
 * destination) — two unrelated events sharing a band are not a loop.
 */
function luminanceOverlapHits(world: SMWorld): Diagnostic[] {
  const out: Diagnostic[] = []
  const transitions = world.scene.events.filter((e) => e.kind === 'transition' && e.to)
  for (const a of transitions) {
    const aMin = a.landWhen?.minLuminance
    if (aMin === undefined) continue
    for (const b of transitions) {
      if (a === b) continue // one event carrying both bands is not a pair
      const bMax = b.landWhen?.maxLuminance
      if (bMax === undefined) continue
      const roundTrip = a.from.includes(b.to ?? '') && b.from.includes(a.to ?? '')
      if (roundTrip && bMax >= aMin) {
        out.push(diag('luminance-overlap', 'error', `events.${a.name}.landWhen`,
          `"${a.name}" lands on bright (≥ ${aMin}) and "${b.name}" comes back on dim (≤ ${bMax}) — the bands overlap, so the pair oscillates.`))
      }
    }
  }
  return out
}

/**
 * `sequence-beat-missing` (error) — a set-piece that walks into a hole.
 *
 * The store refuses to WRITE a beat naming a state that does not exist, and the
 * player refuses to walk one, but neither of those helps the case that actually
 * happens: the beat was fine when it was written and the STATE was deleted
 * afterwards. Deleting a state prunes the events that led only from it — it has
 * always known about events — and knows nothing about the set-pieces that walk
 * through it, so a chain rots quietly and is discovered by whoever presses play.
 *
 * The rot is reported rather than repaired. Silently dropping the beat would
 * destroy authored pacing to hide an author's own edit from them.
 */
function sequenceBeatHits(world: SMWorld): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const seq of world.sequences ?? []) {
    seq.beats.forEach((beat, i) => {
      if (beat.state in world.scene.states) return
      out.push(diag('sequence-beat-missing', 'error', `sequences.${seq.id}.beats[${i}]`,
        `the set-piece "${seq.title}" walks into "${beat.state}", which this world no longer has — it will stop there.`))
    })
  }
  return out
}

/**
 * `objective-unreachable` (error) — a quest that can never be finished.
 *
 * An objective completes when its flag is held, and the flag is granted by an
 * EVENT. Delete that event (or the state it led from, which takes the event
 * with it) and the objective stays on the quest panel forever: the panel is
 * honest, the world is unwinnable, and nothing says so. This is the same family
 * as `unreachable-require` — a flag algebra whose terms have gone missing —
 * pointed at the mission record instead of at the events.
 */
function objectiveUnreachableHits(world: SMWorld): Diagnostic[] {
  const granted = new Set<string>()
  for (const ev of world.scene.events) for (const g of ev.grants ?? []) granted.add(g)
  const out: Diagnostic[] = []
  for (const mission of world.missions ?? []) {
    mission.objectives.forEach((obj, i) => {
      const flag = obj.grants ?? obj.id
      if (granted.has(flag)) return
      out.push(diag('objective-unreachable', 'error', `missions.${mission.id}.objectives[${i}]`,
        `"${obj.text}" completes on the flag "${flag}", which no event grants — this quest can never be finished.`))
    })
  }
  return out
}

/**
 * A mission built from a probe must have kept its own grounding rule.
 *
 * `missionGrounding` could answer this from the stored world the moment the
 * probe set was persisted, and nothing in the product asked it: one iteration
 * of a guard with no call site, which is decorative by this codebase's own
 * definition. The doctrine is where it belongs, because the question survives
 * the authoring run — a mission edited by hand in the inspector afterwards can
 * break a rule the correction rounds enforced at write time, and nothing else
 * would notice.
 *
 * WARNING, not error. An ungrounded objective is a real defect — an action on
 * an object no detector found is one the player may never be able to take — but
 * the target may still be visible in a frame the probe simply missed, and the
 * doctrine's errors block play. Judgement about a picture does not belong in a
 * blocking gate; naming it precisely does.
 */
function missionGroundingHits(world: SMWorld): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const mission of world.missions ?? []) {
    const { verdict, ungrounded } = missionGrounding(mission)
    if (verdict !== 'violated') continue
    for (const { objective, target } of ungrounded) {
      out.push(diag('objective-ungrounded', 'warning', `missions.${mission.id}.objectives.${objective}`,
        `"${objective}" acts on "${target}", which the probe never found in the frame this quest was built from — the player may not be able to see it, let alone act on it.`))
    }
  }
  return out
}

export function runDoctrine(world: SMWorld): Diagnostic[] {
  return [
    ...sequenceBeatHits(world),
    ...objectiveUnreachableHits(world),
    ...missionGroundingHits(world),
    ...noEntranceHits(world),
    ...entranceMissingStateHits(world),
    ...danglingRefHits(world),
    ...transitionNeedsToHits(world),
    ...orphanEventHits(world),
    ...unreachableRequireHits(world),
    ...lethalOverrideHits(world),
    ...sliverEvidenceHits(world),
    ...sharedPhaseCameraHits(world),
    ...autoNeedsPixelsHits(world),
    ...luminanceOverlapHits(world),
    ...unreachableStateHits(world),
    ...noEndingHits(world),
    ...negationLints(world),
    ...whiteoutLints(world),
    ...budgetLints(world),
  ]
}
