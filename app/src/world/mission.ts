import type { SMEvent, SMEventPhase, SMMission, SMObjective, SMState, SMWorld } from './api'

/**
 * The mission compiler: ordered objectives in, playable graph out.
 *
 * This is the piece that makes a mission a MISSION rather than a checklist
 * drawn on top of a graph. Each objective becomes the things the runtime
 * already plays:
 *
 *   · the grounded `target` → an anchor, so the step happens AT the object;
 *   · `confirm` → arrival evidence, so the world must SHOW the action landed;
 *   · `grants` → a flag in the run's ledger, and the next objective's `requires`,
 *     which is how the order is enforced without a separate sequencer;
 *   · `outcome` → a consequence STATE, because a transformation that re-seeds
 *     the state it happened in respawns whatever it just changed;
 *   · `fail` → a sibling transition into a lose ending, so a mission has a
 *     stake and not merely a to-do list;
 *   · the final objective always resolves into a terminal scene carrying the
 *     win card, so victory can never fire on a re-used location.
 *
 * Pure: it takes the world and returns what to add. That makes every rule above
 * provable in a unit test instead of by playing a quest to the end, and it lets
 * the store op, the kernel agent and the eDSL all share one implementation.
 */

/** The "get close" default. */
export const DEFAULT_PROXIMITY = 0.1

/** Negations in inherited prose. Authored prose is the author's business — the
 *  doctrine judges that — but prose COPIED from another state must not smuggle
 *  a negation into a scene the author never wrote. */
const NEGATION = /\b(?:no|not|without|never|none|cannot)\b|n't/i

export interface MissionSpec {
  id: string
  title: string
  objectives: SMObjective[]
  complete?: string | undefined
  win?: { title: string; subtitle?: string } | undefined
  /** The probe's own findings, carried through onto the compiled record so the
   *  stored mission can answer for its own grounding. See `missionGrounding`. */
  verified?: string[] | undefined
}

export interface CompiledMission {
  /** States to create, in order. Existing ids are never overwritten. */
  states: { id: string; state: SMState }[]
  /** Events to add, in order. */
  events: SMEvent[]
  /** Endings to stamp onto states (the win card, and each fail card). */
  endings: { id: string; ending: NonNullable<SMState['ending']> }[]
  /** The normalized mission record the quest panel reads. */
  mission: SMMission
}

export class MissionError extends Error {}

export function compileMission(world: SMWorld, spec: MissionSpec): CompiledMission {
  if (!spec.id?.trim() || !spec.title?.trim()) throw new MissionError('a mission needs an id and a title')
  if (!Array.isArray(spec.objectives) || spec.objectives.length === 0) {
    throw new MissionError('a mission needs at least one objective')
  }
  for (const o of spec.objectives) {
    if (!o?.id?.trim() || !o?.text?.trim()) throw new MissionError('every objective needs an id and text')
  }
  if ((world.missions ?? []).some((m) => m.id === spec.id)) {
    throw new MissionError(`a mission called "${spec.id}" already exists`)
  }

  const existing = world.scene?.states ?? {}
  const entrance = world.entrance?.state ?? Object.keys(existing)[0]
  if (!entrance) throw new MissionError('a mission needs a world with an entrance to start from')

  // A created scene's RESTING movement. `movement` prose describes TRAVEL, and
  // dropping it into the static layer unchanged made the character pace forever
  // after an action — which keeps the scene moving and the anchor chips
  // un-clickable.
  const subject = (world.subject ?? '').trim().replace(/^(an?|the)\s+/i, '').split(/[,.]/)[0]?.trim()
  const REST = subject
    ? `The ${subject} stands completely still and motionless, only the surroundings stirring.`
    : 'The figure stands completely still and motionless, only the surroundings stirring.'

  const states: { id: string; state: SMState }[] = []
  const events: SMEvent[] = []
  const endings: { id: string; ending: NonNullable<SMState['ending']> }[] = []
  const created = new Map<string, SMState>()

  const has = (id: string): boolean => id in existing || created.has(id)
  const look = (id: string): SMState | undefined => existing[id] ?? created.get(id)

  const ensureState = (
    id: string,
    base: string,
    opts: { camera?: string | undefined; movement?: string | undefined; copyFrom?: string | undefined } = {},
  ): void => {
    if (has(id)) return
    const src = look(opts.copyFrom ?? entrance)
    const camera = opts.camera
      ? { static: opts.camera, dynamic: opts.camera }
      : src?.camera
        ? { ...src.camera }
        : { static: '', dynamic: '' }
    const movement = opts.movement
      ? { static: REST, dynamic: opts.movement }
      : src?.movement && !NEGATION.test(`${src.movement.static} ${src.movement.dynamic}`)
        ? { ...src.movement }
        : { static: '', dynamic: '' }
    const state: SMState = { base, camera, movement }
    created.set(id, state)
    states.push({ id, state })
  }

  const win = spec.win ?? { title: 'MISSION COMPLETE', subtitle: `${spec.title} — accomplished.` }
  const last = spec.objectives.length - 1
  const grantText = new Map<string, string>()
  const normalized: SMObjective[] = []
  let prevFlag: string | undefined
  let here = entrance
  let winState: string | null = null

  spec.objectives.forEach((obj, i) => {
    const flag = obj.grants ?? obj.id
    const requires = obj.requires ?? (prevFlag ? [prevFlag] : [])
    const location = obj.location ?? here
    // The LAST objective must transform into a scene reached only by finishing,
    // so the victory card can never fire on a location the player was already
    // standing in.
    const outcome = obj.outcome ?? (i === last ? `The mission is complete. ${win.subtitle ?? ''}`.trim() : undefined)

    ensureState(location, obj.base ?? '', { camera: obj.camera, movement: obj.movement })
    const moving = location !== here
    const from = here

    const phases: SMEventPhase[] | undefined =
      (obj.phases?.length ?? 0) >= 2
        ? obj.phases?.filter((p) => p?.base?.trim()).map((p) => ({
            base: p.base,
            ...(p.movement !== undefined ? { movement: p.movement } : {}),
            ...(p.minMs !== undefined ? { minMs: p.minMs } : {}),
          }))
        : undefined

    const anchor = obj.grounded
      ? {
          label: obj.grounded.target,
          ...(obj.grounded.targetAliases?.length ? { aliases: obj.grounded.targetAliases } : {}),
          minProximity: obj.grounded.proximity ?? DEFAULT_PROXIMITY,
        }
      : undefined
    const landWhen = obj.grounded?.confirm
      ? {
          label: obj.grounded.confirm,
          ...(obj.grounded.confirmAliases?.length ? { aliases: obj.grounded.confirmAliases } : {}),
        }
      : undefined
    // A gated action stays on screen, disabled, saying what unblocks it —
    // rather than vanishing, which reads as the world being broken.
    const lockedHint = requires.length
      ? obj.lockedHint ?? `Need: ${grantText.get(requires[0] ?? '') ?? 'a previous step'}`
      : obj.lockedHint

    let dest = location
    if (outcome) {
      dest = `${location}__${obj.id}`
      ensureState(dest, outcome, { copyFrom: location })
    }

    // An in-place beat that changes no scene and verifies nothing is an
    // OVERRIDE: it must not re-seed. Movement, a verified landing, or a
    // transformation is a TRANSITION.
    const asOverride = !moving && !outcome && !obj.grounded?.confirm
    const body: Partial<SMEvent> =
      phases && phases.length >= 2 ? { phases } : obj.action ? { base: obj.action } : {}

    events.push({
      name: obj.text,
      kind: asOverride ? 'override' : 'transition',
      from: [from],
      ...(asOverride ? {} : { to: dest }),
      ...body,
      ...(anchor ? { anchor } : {}),
      ...(landWhen && !asOverride ? { landWhen } : {}),
      // A completed objective is DONE: once it lands and grants its flag it
      // must not keep offering itself.
      grants: [flag],
      oneShot: true,
      ...(requires.length ? { requires } : {}),
      ...(lockedHint ? { lockedHint } : {}),
    })
    if (!asOverride) here = dest
    if (i === last) winState = dest

    if (obj.fail) {
      // Never an override: a "busted" override would resurrect whoever it
      // busted, which is what `lethal-override` exists to catch.
      const failState = `${location}__fail_${obj.id}`
      const failOutcome = obj.fail.outcome?.trim() || obj.fail.action?.trim() || `${(obj.fail.title || 'The attempt fails').trim()}.`
      const failAction = obj.fail.action?.trim() || obj.fail.outcome?.trim() || obj.fail.name?.trim() || 'The attempt goes wrong.'
      ensureState(failState, failOutcome, { copyFrom: location })
      endings.push({
        id: failState,
        ending: {
          kind: 'lose',
          title: obj.fail.title?.trim() || 'FAILED',
          ...(obj.fail.subtitle ? { subtitle: obj.fail.subtitle } : {}),
        },
      })
      events.push({
        name: obj.fail.name?.trim() || `Wrong move (${obj.id})`,
        kind: 'transition',
        from: [from],
        to: failState,
        base: failAction,
      })
    }

    normalized.push({
      id: obj.id,
      text: obj.text,
      location,
      ...(obj.base ? { base: obj.base } : {}),
      ...(obj.camera ? { camera: obj.camera } : {}),
      ...(obj.movement ? { movement: obj.movement } : {}),
      ...(obj.action ? { action: obj.action } : {}),
      ...(obj.phases?.length ? { phases: obj.phases } : {}),
      ...(obj.grounded ? { grounded: obj.grounded } : {}),
      ...(outcome ? { outcome } : {}),
      grants: flag,
      ...(requires.length ? { requires } : {}),
      ...(lockedHint ? { lockedHint } : {}),
      ...(obj.fail ? { fail: obj.fail } : {}),
    })
    grantText.set(flag, obj.text)
    prevFlag = flag
  })

  if (winState) {
    endings.push({
      id: winState,
      ending: { kind: 'win', title: win.title, ...(win.subtitle ? { subtitle: win.subtitle } : {}) },
    })
  }

  return {
    states,
    events,
    endings,
    mission: {
      id: spec.id,
      title: spec.title,
      objectives: normalized,
      ...(spec.complete ?? prevFlag ? { complete: spec.complete ?? prevFlag } : {}),
      // Carried, not derived: this compiler BUILDS the record that persists, so
      // a field it does not copy is a field the store silently drops however
      // carefully the op passed it in.
      ...(spec.verified ? { verified: spec.verified } : {}),
    },
  }
}

/** Which objectives are done, given the run's flag ledger. The quest panel and
 *  the completion check read the SAME function — one answer to "where am I". */
export function missionProgress(
  mission: SMMission,
  flags: ReadonlySet<string>,
): { done: boolean[]; activeIndex: number; complete: boolean } {
  const done = mission.objectives.map((o) => flags.has(o.grants ?? o.id))
  const activeIndex = done.findIndex((d) => !d)
  const complete = mission.complete ? flags.has(mission.complete) : done.every(Boolean)
  return { done, activeIndex, complete }
}

/**
 * Does a stored mission's grounding hold?
 *
 * The quest path's entire promise is that every objective names something a
 * detector really found — never an object a model imagined, because an action
 * on an undetectable thing is an action the player can never take. Until the
 * probe's findings were persisted beside the mission (`SMMission.verified`),
 * that promise could only be checked by re-running the probe, which made it
 * unfalsifiable from the artifact. This answers it from the stored world.
 *
 * The three outcomes are kept deliberately distinct, because collapsing them
 * loses the thing worth knowing:
 *
 *   'unprobed'  no `verified` field — this mission was not built from a probe,
 *               so there is nothing to hold it to. NOT a failure.
 *   'held'      every grounded target appears in the probe's own set.
 *   'violated'  at least one target does not — and `ungrounded` names them.
 *
 * An empty `verified` array is a probe that ran and found nothing, which is a
 * real result and refuses any grounded objective; a missing field is silence.
 */
export function missionGrounding(mission: SMMission): {
  verdict: 'unprobed' | 'held' | 'violated'
  ungrounded: { objective: string; target: string }[]
} {
  if (mission.verified === undefined) return { verdict: 'unprobed', ungrounded: [] }
  const allowed = new Set(mission.verified.map((v) => v.trim().toLowerCase()).filter(Boolean))
  const ungrounded: { objective: string; target: string }[] = []
  for (const objective of mission.objectives) {
    const target = objective.grounded?.target?.trim()
    if (!target) continue
    if (!allowed.has(target.toLowerCase())) ungrounded.push({ objective: objective.id, target })
  }
  return { verdict: ungrounded.length > 0 ? 'violated' : 'held', ungrounded }
}
