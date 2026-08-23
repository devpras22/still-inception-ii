import type { Diagnostic, SMEvent, SMEventPhase, SMMission, SMState, SMWorld } from '../../world'
import { promptForBeat } from '../../play'
import { compileMission, runDoctrine } from '../../world'
import type { MissionSpec } from '../../world'
import { Evidence } from './evidence'
import { allowedOf, textOf } from './fragments'
import type { Textish } from './fragments'

/**
 * Stagecraft layer 3 — programs. Immutable world builders that compile to the
 * EXACT `SMWorld` the store already holds: no runtime change, no second world
 * shape, byte-exact prose.
 *
 * Why this layer is the point of the whole language, in Outlines' framing:
 * it moves failure detection "from runtime to type-checking time". Every
 * hand-won rule in `world/doctrine.ts` — negation summons the thing it denies,
 * a blown-white frame resolves backward, a shared camera narrates the ending
 * and teleports the model there, a death in an override resurrects, 1900
 * characters get silently truncated — becomes a COMPILE ERROR with a precise
 * field path, before a single GPU second is spent rendering the mistake.
 *
 * `compile()` throws on any error-severity diagnostic and returns warnings;
 * `check()` returns everything and never throws (tsc's `--noEmit`).
 *
 * Builders are immutable: `.state()` / `.event()` return a NEW program, which
 * is Guidance's `lm += …` model — programs fork cheaply, so an A/B variant of a
 * world is a value, not a copy-paste.
 *
 * Two renames from the schema, both earning their keep: `until:` takes an
 * evidence builder and compiles to `landWhen`, and every text field accepts a
 * `Fragment | string | number`. Everything else mirrors the schema exactly.
 */

export class CompileError extends Error {
  readonly diagnostics: Diagnostic[]
  constructor(message: string, diagnostics: Diagnostic[]) {
    super(message)
    this.name = 'CompileError'
    this.diagnostics = diagnostics
  }
}

export interface LayerPairish {
  static: Textish
  dynamic: Textish
}

export interface VariantSpec {
  label: string
  base: Textish
  camera?: LayerPairish | undefined
  movement?: LayerPairish | undefined
}

export interface StateSpec {
  base: Textish
  camera?: LayerPairish | undefined
  movement?: LayerPairish | undefined
  ambient?: Textish[] | undefined
  ending?: { kind: 'win' | 'lose'; title: string; subtitle?: string | undefined } | undefined
  /** A/B alternates for this state's prose. The state's own fields are A. */
  variants?: VariantSpec[] | undefined
}

export interface PhaseSpec {
  base: Textish
  camera?: Textish | undefined
  movement?: Textish | undefined
  detail?: Textish | undefined
  minMs?: number | undefined
}

export interface EventSpec {
  kind: 'transition' | 'override' | 'terminal'
  from: string[]
  to?: string | undefined
  base?: Textish | undefined
  detail?: Textish | undefined
  hotkey?: string | undefined
  hidden?: boolean | undefined
  oneShot?: boolean | undefined
  requires?: string[] | undefined
  grants?: string[] | undefined
  anchor?: { label: string; aliases?: string[]; minProximity?: number } | undefined
  phases?: PhaseSpec[] | undefined
  /** The evidence that lands this transition — compiles to `landWhen`. */
  until?: Evidence | undefined
}

export interface WorldMeta {
  name?: string | undefined
  description?: string | undefined
  cover?: string | null | undefined
  entrance?: { state: string; image?: { label?: string; src: string } | undefined } | undefined
}

/** Where a suppression applies: the exact field path the doctrine reports. */
type AllowMap = Map<string, Set<string>>

export class Program {
  private constructor(
    private readonly id: string,
    private readonly meta: WorldMeta,
    private readonly states: ReadonlyArray<readonly [string, StateSpec]>,
    private readonly events: ReadonlyArray<readonly [string, EventSpec]>,
    private readonly missions: ReadonlyArray<MissionSpec>,
  ) {}

  static create(id: string, meta: WorldMeta = {}): Program {
    return new Program(id, meta, [], [], [])
  }

  /** Add a state. Returns a NEW program — the builder is a value. */
  state(id: string, spec: StateSpec): Program {
    return new Program(this.id, this.meta, [...this.states, [id, spec] as const], this.events, this.missions)
  }

  /** Add an event. Returns a NEW program. */
  event(name: string, spec: EventSpec): Program {
    return new Program(this.id, this.meta, this.states, [...this.events, [name, spec] as const], this.missions)
  }

  /**
   * Add a mission. It COMPILES (`world/mission.ts`) into the states, events,
   * flags and endings the runtime plays — so a program that declares a quest
   * does not also hand-author the graph behind it, and the two can never drift.
   */
  mission(spec: MissionSpec): Program {
    return new Program(this.id, this.meta, this.states, this.events, [...this.missions, spec])
  }

  /** Every diagnostic, suppressions included, without throwing. */
  check(): Diagnostic[] {
    const { world, allow } = this.assemble()
    return applyAllow(runDoctrine(world), allow)
  }

  /**
   * The world, or the reason there isn't one. Any error-severity diagnostic
   * throws — that is the guarantee the layer exists for: a world that violates
   * the doctrine never reaches a store, a player or a GPU.
   */
  compile(): { world: SMWorld; warnings: Diagnostic[] } {
    const { world, allow } = this.assemble()
    const diagnostics = applyAllow(runDoctrine(world), allow)
    const errors = diagnostics.filter((d) => d.severity === 'error')
    if (errors.length > 0) {
      throw new CompileError(
        `${this.id}: ${errors.length} doctrine error${errors.length === 1 ? '' : 's'} — ` +
          errors.map((d) => `${d.path}: ${d.message}`).join(' · '),
        diagnostics,
      )
    }
    return { world, warnings: diagnostics.filter((d) => d.severity !== 'error') }
  }

  /** The world WITHOUT checking it — for tests that need to see what a broken
   *  program produces, and for nothing else. */
  assembleUnchecked(): SMWorld {
    return this.assemble().world
  }

  private assemble(): { world: SMWorld; allow: AllowMap } {
    const allow: AllowMap = new Map()
    const note = (path: string, value: Textish | undefined): void => {
      if (value === undefined) return
      const ids = allowedOf(value)
      if (ids.size === 0) return
      const set = allow.get(path) ?? new Set<string>()
      for (const id of ids) set.add(id)
      allow.set(path, set)
    }

    const states: Record<string, SMState> = {}
    for (const [id, spec] of this.states) {
      note(`states.${id}.base`, spec.base)
      const state: SMState = { base: textOf(spec.base) }
      if (spec.camera) state.camera = { static: textOf(spec.camera.static), dynamic: textOf(spec.camera.dynamic) }
      if (spec.movement) {
        note(`states.${id}.movement.static`, spec.movement.static)
        note(`states.${id}.movement.dynamic`, spec.movement.dynamic)
        state.movement = { static: textOf(spec.movement.static), dynamic: textOf(spec.movement.dynamic) }
      }
      if (spec.ambient) {
        spec.ambient.forEach((a, i) => note(`states.${id}.ambient.${i}`, a))
        state.ambient = spec.ambient.map(textOf)
      }
      if (spec.ending) {
        state.ending = {
          kind: spec.ending.kind,
          title: spec.ending.title,
          ...(spec.ending.subtitle !== undefined ? { subtitle: spec.ending.subtitle } : {}),
        }
      }
      if (spec.variants) {
        state.variants = spec.variants.map((v) => ({
          label: v.label,
          base: textOf(v.base),
          ...(v.camera ? { camera: { static: textOf(v.camera.static), dynamic: textOf(v.camera.dynamic) } } : {}),
          ...(v.movement ? { movement: { static: textOf(v.movement.static), dynamic: textOf(v.movement.dynamic) } } : {}),
        }))
      }
      states[id] = state
    }

    const events: SMEvent[] = []
    for (const [name, spec] of this.events) {
      note(`events.${name}.base`, spec.base)
      note(`events.${name}.detail`, spec.detail)
      const event: SMEvent = { name, kind: spec.kind, from: [...spec.from] }
      if (spec.to !== undefined) event.to = spec.to
      if (spec.base !== undefined) event.base = textOf(spec.base)
      if (spec.detail !== undefined) event.detail = textOf(spec.detail)
      if (spec.hotkey !== undefined) event.hotkey = spec.hotkey
      if (spec.hidden !== undefined) event.hidden = spec.hidden
      if (spec.oneShot !== undefined) event.oneShot = spec.oneShot
      if (spec.requires !== undefined) event.requires = [...spec.requires]
      if (spec.grants !== undefined) event.grants = [...spec.grants]
      if (spec.anchor !== undefined) event.anchor = { ...spec.anchor }
      if (spec.phases !== undefined) {
        event.phases = spec.phases.map((p, i): SMEventPhase => {
          note(`events.${name}.phases.${i}.base`, p.base)
          const phase: SMEventPhase = { base: textOf(p.base) }
          if (p.camera !== undefined) phase.camera = textOf(p.camera)
          if (p.movement !== undefined) phase.movement = textOf(p.movement)
          if (p.detail !== undefined) phase.detail = textOf(p.detail)
          if (p.minMs !== undefined) phase.minMs = p.minMs
          return phase
        })
      }
      if (spec.until !== undefined) event.landWhen = spec.until.toLandWhen()
      events.push(event)
    }

    // Missions compile LAST: they read the states that already exist to decide
    // what to inherit and where to start.
    const world: SMWorld = {
      id: this.id,
      ...(this.meta.name !== undefined ? { name: this.meta.name } : {}),
      ...(this.meta.description !== undefined ? { description: this.meta.description } : {}),
      ...(this.meta.cover !== undefined ? { cover: this.meta.cover } : {}),
      ...(this.meta.entrance !== undefined ? { entrance: this.meta.entrance } : {}),
      scene: { states, events },
    }
    const compiledMissions: SMMission[] = []
    for (const spec of this.missions) {
      const compiled = compileMission(world, spec)
      for (const { id, state } of compiled.states) states[id] = state
      for (const { id, ending } of compiled.endings) {
        const target = states[id]
        if (target) target.ending = ending
      }
      events.push(...compiled.events)
      compiledMissions.push(compiled.mission)
      world.missions = compiledMissions
    }
    return { world, allow }
  }
}

/**
 * Structural rules are graph properties and CANNOT be waived by a fragment —
 * a dangling reference is not a matter of taste. Only the text-register lints
 * are suppressible, exactly as the language's own design says.
 */
const SUPPRESSIBLE = new Set(['negation', 'whiteout', 'lethal-override', 'sliver-evidence'])

/** Downgrade allowed findings to `info` rather than dropping them: a rule you
 *  silently switched off is a rule you will forget you switched off. */
function applyAllow(diagnostics: Diagnostic[], allow: AllowMap): Diagnostic[] {
  if (allow.size === 0) return diagnostics
  return diagnostics.map((d) => {
    if (!SUPPRESSIBLE.has(d.lint)) return d
    if (!allow.get(d.path)?.has(d.lint)) return d
    return { ...d, severity: 'info' as const, message: `suppressed by allow('${d.lint}'): ${d.message}` }
  })
}

/** Start a program. `world('lane', {...}).state(…).event(…).compile()`. */
export function world(id: string, meta: WorldMeta = {}): Program {
  return Program.create(id, meta)
}

/**
 * One event of a program, assembled into the exact prose the kernel will stream.
 *
 * The eDSL could describe a world and check evidence against a recording
 * (`toEvidenceSpec`, `matches`) but had no way to ask "what will the model
 * actually be told when this event fires" — so comparing two phrasings meant
 * hand-copying prose out of the compiled world and hoping it matched what plays.
 *
 * The alternative is a hand-maintained replica of the player's assembler, kept
 * byte-faithful by hand — a shape that invites drift. This calls the player's
 * own `promptForBeat` instead: there is one assembler, so a candidate cannot
 * disagree with what streams.
 *
 * `variant: 'dynamic'` asks for the travelling layers — the camera and movement
 * a player sees while MOVING rather than standing still — which is the pair most
 * worth A/B-ing, and the one hardest to read off a graph by eye.
 */
export function candidateFor(
  program: Program,
  eventName: string,
  opts: { fromState?: string; variant?: 'static' | 'dynamic' } = {},
): { id: string; title: string; text: string; note: string } {
  const { world } = program.compile()
  const ev = world.scene.events.find((e) => e.name === eventName)
  if (!ev) {
    const had = world.scene.events.map((e) => e.name).join(', ')
    throw new CompileError(`no event named "${eventName}" — this program has: ${had || '(none)'}`, [])
  }
  const fromId = opts.fromState ?? ev.from[0] ?? ''
  const state = world.scene.states[fromId]
  if (!state) throw new CompileError(`event "${eventName}": unknown from-state "${fromId}"`, [])

  // Layers fall back to the STATE when the event does not override them, which
  // is what makes an event a change to a scene rather than a scene of its own.
  const moving = (opts.variant ?? 'static') === 'dynamic'
  // An event may carry a bare string where a state carries a pair: one line of
  // prose that reads the same standing still or travelling. `layer` collapses
  // both shapes so the caller never has to know which one an author wrote.
  const layer = (v: string | { static: string; dynamic: string } | undefined): string | undefined =>
    v === undefined ? undefined : typeof v === 'string' ? v : moving ? v.dynamic : v.static
  const camera = layer(ev.camera ?? state.camera)
  const movement = layer(ev.movement ?? state.movement)
  const text = promptForBeat({
    text: ev.base ?? state.base ?? '',
    ...(camera ? { camera } : {}),
    ...(movement ? { movement } : {}),
  })
  const variant = moving ? 'dynamic' : 'static'
  return {
    id: `${world.id}.${eventName}.${fromId}.${variant}`,
    title: `${eventName} (${fromId}, ${variant})`,
    text,
    note: `assembled by candidateFor() from "${world.id}" with the player's own promptForBeat`,
  }
}
