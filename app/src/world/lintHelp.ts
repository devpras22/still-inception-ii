import type { Diagnostic, PublicOp, SMWorld } from './api'

/**
 * Creator-facing translations for the doctrine lints (`./doctrine.ts`).
 *
 * This exists because the lint engine speaks DOCTRINE ("anchor without
 * minProximity — a sliver at the frame edge counts") and a creator cannot act on
 * that. The panel used to expand "what's this?" into the raw rule id, which is
 * the same problem wearing a disclosure triangle: it tells you what the rule is
 * CALLED, never what to do.
 *
 * So each code gets a plain-English title, an explanation that says what it
 * means AND how to fix it, and — where the fix is deterministic and
 * non-destructive — a one-click Fix. Anything needing a human decision
 * (rewriting prose, choosing a destination) deliberately has no button: the
 * explanation says what to do and clicking the row jumps to the node.
 */
export interface LintHelp {
  /** Headline shown in place of the raw code. */
  title: string
  /** Plain English: what it means, why it matters, how to fix it. */
  what: string
}

export const LINT_HELP: Record<string, LintHelp> = {
  negation: {
    title: 'Avoid negative wording',
    what:
      'The world model paints whatever words it sees — so "no rotor" actually summons a rotor. ' +
      'Describe what IS there, not what isn\'t (e.g. "an empty sky" instead of "no aircraft").',
  },
  whiteout: {
    title: "Don't describe a blinding flash / white-out",
    what:
      'A blown-white frame gives the model no spatial anchor, so it can snap back to the previous ' +
      'scene. Describe what stays visible through the moment instead of a flash or bloom.',
  },
  'dangling-ref': {
    title: "Link points to a state that doesn't exist",
    what:
      "This references a state that isn't in the graph — usually a typo, or a state that was renamed " +
      'or deleted. Point it at an existing state, or create the one it names.',
  },
  'unreachable-require': {
    title: 'A locked door with no key',
    what:
      'This step waits on a flag that no event ever grants, so the player can never get past it. ' +
      'Add an event that grants the flag, or remove the requirement.',
  },
  'transition-needs-to': {
    title: 'Destination problem',
    what:
      'A transition must point to a destination state; an override must NOT (it returns to the same ' +
      'state when it ends). Set a destination for the transition, or clear it from the override.',
  },
  'lethal-override': {
    title: 'A death that comes back to life',
    what:
      'An override snaps back to the original scene when it ends — so anyone "killed" in it resurrects. ' +
      'Make it a transition into a new, changed state instead of an override.',
  },
  'sliver-evidence': {
    title: 'Object might be cut off at the frame edge',
    what:
      "This interaction is anchored to an object but doesn't require how MUCH of it is on screen — a " +
      'tiny sliver at the edge would count, so the chip arms from across the room. Require a minimum ' +
      'on-screen size so it only arms when the object is really in front of the player. "Fix" sets a ' +
      'sensible minimum (15% of the frame).',
  },
  'shared-phase-camera': {
    title: 'One camera shared across scenes',
    what:
      'This multi-step event reuses a single camera across its stages, which can teleport the model ' +
      'to the ending — a camera that says "as he steps out" is describing the END of the move while ' +
      'the first beat is still playing. Give each phase its own camera description.',
  },
  'sequence-beat-missing': {
    title: 'A set-piece walks into a room that is gone',
    what:
      'This chain of shots passes through a state the world no longer has, so it will stop there. ' +
      'Deleting a state does not touch the set-pieces that walk through it — on purpose, because ' +
      'quietly dropping a beat would rewrite your pacing to hide the edit. Point the beat at another ' +
      'state, or remove it from the chain.',
  },
  'objective-unreachable': {
    title: 'A quest step that can never be completed',
    what:
      'This objective is ticked off when its flag is granted, and no event in the world grants it — ' +
      'usually because the event that did was deleted, or the state it led from was. The quest panel ' +
      'will show the step forever. Grant the flag from an event, or drop the objective.',
  },
  'auto-needs-pixels': {
    title: 'Auto-trigger has nothing to watch',
    what:
      'An automatic trigger fires on what the picture SHOWS — brightness or movement. Without one of ' +
      'those it can never fire and the step silently dead-ends. Add a luminance or motion threshold, ' +
      'or drop auto and let the player press it.',
  },
  'luminance-overlap': {
    title: 'Two triggers fight each other',
    what:
      'A forward trigger (fires on bright) and its reverse (fires on dim) overlap, so the scene ' +
      'oscillates back and forth on its own. Separate the bright and dim thresholds so the bands ' +
      'do not both hold at once.',
  },
  budget: {
    title: 'Scene description is too long',
    what:
      "The assembled prompt is over the model's limit (1900 characters) and gets silently cut off. " +
      'Trim the base / camera / movement text for this state.',
  },
  'no-entrance': {
    title: 'The world has no way in',
    what:
      'Every world opens on one state. Pick the state a player should start in and set it as the ' +
      'entrance — without one there is nothing to stream on play.',
  },
  'entrance-missing-state': {
    title: 'The entrance points at nothing',
    what:
      'The entrance names a state that is not in the graph — usually one that was renamed or deleted. ' +
      'Point the entrance at a state that exists.',
  },
  'unreachable-state': {
    title: 'Nothing leads here',
    what:
      'No event reaches this state from the entrance, so a player can never see it. Add an event that ' +
      'transitions into it, or delete it.',
  },
  'no-ending': {
    title: 'The world never ends',
    what:
      'No state is marked as an ending, so play has nowhere to stop. Mark the state that concludes the ' +
      'story as an ending (a win or a loss).',
  },
  'orphan-event': {
    title: 'This event can never fire',
    what:
      'The event lists a from-state that is not in the graph, so it is offered from nowhere. Point it ' +
      'at a state that exists, or delete it.',
  },
}

/** Humanize an unknown code as a fallback ('foo-bar' → 'Foo bar'). */
function humanize(code: string): string {
  const s = code.replace(/[-_]/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function lintTitle(code: string): string {
  return LINT_HELP[code]?.title ?? humanize(code)
}

export function lintWhat(code: string): string {
  return LINT_HELP[code]?.what ?? 'No extra detail for this rule yet.'
}

// ── Safe one-click auto-fixes ───────────────────────────────────────────────
// Only deterministic, non-destructive fixes live here: anything that needs a
// human decision has no button.

/** Default: 15% of the frame. */
export const DEFAULT_MIN_PROXIMITY = 0.15

const EVENT_PATH_RE = /^events\.([^.]+)/

/** Whether `d` has a one-click fix. */
export function canAutoFix(d: Diagnostic): boolean {
  return d.lint === 'sliver-evidence' && EVENT_PATH_RE.test(d.path)
}

/**
 * The op batch that fixes `d`, or an empty array when there is nothing safe to
 * do. Ops rather than a rewritten world: every write in this studio goes
 * through the same validated `author.ops` path, and a panel that hand-built a
 * new world object would be a second way to write a graph.
 */
export function autoFixOps(world: SMWorld, d: Diagnostic): PublicOp[] {
  if (!canAutoFix(d)) return []
  const name = EVENT_PATH_RE.exec(d.path)?.[1]
  if (!name) return []
  const event = (world.scene?.events ?? []).find((e) => e.name === name)
  const anchor = event?.anchor
  if (!anchor || anchor.minProximity !== undefined) return []
  // `patch`, not `event`: the store's op reader DROPS an `event` key on
  // update_event (`store/local.ts` opPatch's drop list) and applies the rest,
  // so the wrong shape is not an error — it is an op that silently does
  // nothing. `tests/unit/doctrine.test.ts` writes this through the real store
  // for exactly that reason.
  return [{ op: 'update_event', name, patch: { anchor: { ...anchor, minProximity: DEFAULT_MIN_PROXIMITY } } }]
}
