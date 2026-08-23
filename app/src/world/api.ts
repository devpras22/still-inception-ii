export type NullablePatch<T> = { [K in keyof T]?: T[K] | null };
/**
 * Alakazam /v1 API client — the ONLY way this app touches data. Everything the
 * studio does (create, read/edit graph, agent edit, validate/lint, versions,
 * fork, sessions, vision/grounding, usage) is a call here. No internal SDK, no
 * Supabase — just the public API with your app's API key.
 *
 * Auth: a SECRET key (`sk_…`) with worlds:read + worlds:write + sessions:mint.
 * In a real product your BACKEND holds the secret and this client would call your
 * backend; for a self-hosted studio the operator supplies the key in Settings.
 *
 * Every method below is a BOUNDARY: the hosted API is a network service this
 * app does not control, so its JSON is `unknown` until proven otherwise. Each
 * method validates the top-level fields its own callers actually rely on
 * (see narrow.ts) and throws `HttpError` — a real ApiError — the moment the
 * wire disagrees with what it promised, rather than handing a caller an
 * `undefined` three components downstream. Deep interiors (an SMState's own
 * fields, one Diagnostic's own fields) stay exactly as loosely typed as the
 * domain interfaces below already declare them — this is a boundary check,
 * not a validation library.
 */

import {
  HttpError,
  fail,
  isRecord,
  isRecordOf,
  isArrayOf,
  expectRecord,
  reqString,
  reqStringOrNull,
  reqNumber,
  reqBoolean,
  reqArray,
  reqRecordField,
  optString,
  optStringOrNull,
  optNumber,
  optBoolean,
  defaultArray,
} from './narrow';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ClientConfig {
  baseUrl: string;
  apiKey: string;
}

export interface ApiError extends Error {
  status: number;
  detail: string;
  diagnostics?: unknown[] | undefined;
}

// ── Minimal domain types (the public SMWorld contract, loosely typed) ────────
export interface LayerPair { static: string; dynamic: string }
/**
 * An ALTERNATE prompt for a state — the B side of an A/B test.
 *
 * It carries the same prose layers a state does, and it is played on the SAME
 * entrance seed, so the comparison isolates the prompt: same picture to start
 * from, different words, different world.
 *
 * This was `unknown[]` here for a while, which is exactly what a field
 * nothing reads looks like — the ops could write one and no type described it.
 */
export interface SMPromptVariant {
  /** Short tag on the chip: B, C, … */
  label: string
  base: string
  camera?: LayerPair | undefined
  movement?: LayerPair | undefined
  ambient?: string[] | undefined
}

export interface SMState {
  base: string
  camera?: LayerPair | undefined
  movement?: LayerPair | undefined
  ambient?: string[] | undefined
  ending?: { kind: 'win' | 'lose'; title: string; subtitle?: string | undefined }
  variants?: SMPromptVariant[] | undefined
  /**
   * What the player READS — and the only prose here that is not a prompt.
   *
   * `base`, `camera`, `movement` and `ambient` are instructions to a world
   * model, which never shows them verbatim; this is display copy shown beside
   * the picture. Narration is ignored by the world-model runtime and NOT
   * checked by the lint suite — it's UI display copy, not a generation
   * prompt.
   *
   * That exemption is the whole reason the field is worth having separately. A
   * negation renders wrong when a model reads it ("NOT a rotor" summons a
   * rotor) and reads perfectly when a person does; policing "There is no way
   * back" here would be a rule aimed at the wrong reader, and counting it
   * against the prompt budget would charge an author for words nothing streams.
   */
  narration?: string | undefined
  /**
   * A camera that drives ITSELF while this state is current.
   *
   * An event's `drive` is a move pressing its own controls for the length of
   * that move; this is a STANDING one — an orbit, a traveling shot, a slow
   * drift — held for as long as the player is here. The prompt and the
   * channels must AGREE, so an orbit pairs `{ movement: 'strafe_left',
   * lookHorizontal: 'right' }` with camera prose that says the camera arcs
   * clockwise.
   *
   * `keepCentered` is the visual servo: a detect label probed while the state
   * plays, with a corrective look pulsed when the subject drifts off centre.
   * Fail-open by construction — a missed detection simply leaves the base drive
   * alone, because a servo that panics on a dropped frame is worse than one
   * that waits for the next.
   *
   * There is no numeric orbit-radius knob here: this studio's provider
   * contract carries command TOKENS rather than name+data, so a rate-trim
   * servo is out of reach until that contract grows a number. The pulse path
   * below is the fallback for the same job.
   */
  autopilot?: {
    movement?: SMDrive['movement']
    lookHorizontal?: SMDrive['lookHorizontal']
    lookVertical?: SMDrive['lookVertical']
    keepCentered?: { label: string; aliases?: string[] | undefined } | undefined
  } | undefined
  /**
   * The visual evidence that you have ARRIVED here, as a detect label.
   *
   * A transition INTO this state verifies on it when the event itself carries
   * no `landWhen` — so a world can be gated once, at the destination, instead
   * of on every door into it. Pick something visible only once you are in the
   * room, never from the doorway of the last one.
   */
  arriveLabel?: string | undefined
}
/** A live DETECT query the player can point at, plus the geometry the probe
 *  MEASURED for it at authoring time. `minProximity` (the short-side extent an
 *  object must fill before it counts as "close enough to touch") and
 *  `expectedAspect` matter because the player's chip rules are only as honest
 *  as the numbers behind them, and an anchor with no measured proximity
 *  is armed the instant it is centred, however far away it is. */
export interface SMEventAnchor { label: string; aliases?: string[] | undefined; minProximity?: number | undefined; expectedAspect?: { min: number; max: number } | undefined }
/**
 * One beat of a multi-step event. A transition that CHOREOGRAPHS — crossing a
 * threshold, climbing into a vehicle — cannot be one prompt: the world model
 * resolves a prompt swap at a chunk boundary, so a single description of "the
 * whole move" lands the destination while the pixels still show the source.
 * Phases are that move, told one stage at a time.
 */
export interface SMEventPhase {
  /** Full scene description for this beat — replaces the event's base. */
  base: string
  /** Camera lock for THIS beat. Phases must not share one camera that narrates
   *  the sequence's ENDING: a camera saying "as he steps out" appended to
   *  phase 1 teleports the model straight to the end of the move. */
  camera?: string | undefined
  /** Choreography for this beat — the phase IS the motion. */
  movement?: string | undefined
  /** Appended flourish sentence. */
  detail?: string | undefined
  /** How long this beat streams before advancing. Default 5000ms — roughly one
   *  to two of the model's own chunk boundaries. */
  minMs?: number | undefined
}

/**
 * The evidence that a transition has ARRIVED, watched in the live frame instead
 * of assumed after a timer. A world model has no geometry: the only honest
 * answer to "are we there yet" is what the picture shows.
 *
 * Luminance and motion are computed from the frame the player already captures
 * (free, no model call); a label goes through the vision provider, the same one
 * the play chips use. `hits` is cumulative, not consecutive — a real scene's
 * detections alternate. `timeoutMs` is a FAIL-OPEN ceiling: a missed label must
 * never trap a player mid-event.
 */
export interface SMLandWhen {
  /** Detect-label evidence, resolved like an anchor. */
  label?: string | undefined
  aliases?: string[] | undefined
  /** Minimum extent (min(w,h), 0..1) — demands presence, not a sliver at the
   *  frame edge. */
  minExtent?: number | undefined
  /** Mean frame luminance (0..255) the picture must EXCEED — the zero-cost
   *  signal for dark→bright arrivals. */
  minLuminance?: number | undefined
  /** …and the mirror, for bright→dark. */
  maxLuminance?: number | undefined
  /** Mean absolute per-pixel change between samples that must be exceeded — the
   *  signature of travelling. */
  minMotion?: number | undefined
  /** …and the mirror: the scene came to REST, which is what an arrival looks
   *  like. */
  maxMotion?: number | undefined
  /** Ticks of evidence required before landing. Default 1. */
  hits?: number | undefined
  /** Fail-open ceiling: land unverified after this long. Default 20000ms. */
  timeoutMs?: number | undefined
  /** Trigger-zone mode: the same evidence ALSO completes this transition during
   *  free roam, with no press — walking through the door IS stepping outside.
   *  Honored for luminance/motion evidence only: those are free per tick and
   *  unambiguous in a way an object label is not (a road being visible does not
   *  mean you are driving down it). */
  auto?: boolean | undefined
}

/**
 * Control-channel inputs authored INTO the graph.
 *
 * The world model listens to two channels — the prompt AND the movement/look
 * grammar — and they must agree: a take-off whose text says 'leaps and climbs'
 * while the movement channel says idle sends contradictory signals.
 *
 * So an authored move can press the controls it describes, instead of relying
 * on a player to hold the right key while reading prose about running.
 */
export interface SMDrive {
  movement?: 'forward' | 'back' | 'strafe_left' | 'strafe_right' | undefined
  lookHorizontal?: 'left' | 'right' | undefined
  lookVertical?: 'up' | 'down' | undefined
}

export interface SMEvent {
  name: string
  kind: 'transition' | 'override' | 'terminal'
  from: string[]
  to?: string | undefined
  base?: string | undefined
  detail?: string | undefined
  hotkey?: string | null | undefined
  hidden?: boolean | undefined
  oneShot?: boolean | undefined
  requires?: string[] | undefined
  grants?: string[] | undefined
  anchor?: SMEventAnchor | undefined
  phases?: SMEventPhase[] | undefined
  landWhen?: SMLandWhen | undefined
  lockedHint?: string | undefined
  /**
   * The event's OWN framing while it plays, overriding the state's.
   *
   * A state's camera describes standing in a place; a move through a doorway is
   * framed differently from being in the room on either side of it, and until
   * now only a PHASE could say so — which meant an author had to break a
   * one-beat move into phases purely to reframe it.
   */
  camera?: string | undefined
  /** …and what the body does while it plays, for the same reason. */
  movement?: string | undefined
  /**
   * Minimum time this event streams before the destination is allowed to land.
   *
   * The anti-rollback knob. A world model resolves a prompt swap at a chunk
   * boundary, so landing the destination while the pixels still show the source
   * is what makes it resolve BACKWARD. `landWhen` answers this with evidence
   * when there is evidence to be had; `minPlayMs` is the floor for when there
   * is not.
   */
  minPlayMs?: number | undefined
  /**
   * A DIEGETIC CONSOLE — something in the world the player types into.
   *
   * `kind: "terminal"` behaves like an override (sustained, no
   * `to`, the world keeps breathing) but renders a typed console instead of
   * streaming a prompt. Its persona and TRUTH LEDGER — what this machine is
   * willing and able to say — live server-side, with the client passing the
   * live flag set each turn so the server can decide who is speaking and which
   * facts are sayable.
   *
   * There is no server here, so the ledger is AUTHORED: the persona and the
   * facts are written into the world and sent to the author's own model with
   * the player's line. It keeps the interesting property intact: the console
   * can only say what the author gave it, and what it may say CHANGES with the flags the player
   * holds, because gated facts are filtered out before the model ever sees
   * them. A secret the model was never told is a secret it cannot leak.
   */
  terminal?: {
    /** Who is speaking, and how. */
    persona: string
    /** What it may say. A fact gated on flags the player does not hold is
     *  withheld from the model entirely, not merely discouraged. */
    facts?: { text: string; requires?: string[] | undefined }[] | undefined
    /** The line it prints before the player types anything. */
    greeting?: string | undefined
  } | undefined
  /** Controls held WHILE this event plays, released when it lands or ends. */
  drive?: SMDrive | undefined
  /**
   * A destination you DRIVE to — the mission waypoint.
   *
   * The whole design fits in one line: the world model has no
   * geometry, so POSITION = ACCUMULATED TRAVEL. Nothing in a generated world
   * knows where anything is; what the runtime does know is how long the player
   * has been holding forward. So distance is INTEGRATED FROM INPUT — an
   * odometer ticks down while they drive, a blip shows what is left, and at
   * zero the event plays itself, its first phase being the destination coming
   * into view.
   *
   * Which makes this the opposite of a cheat. A compass in a rendered game
   * reads a position that exists; here the travel IS the position, and the
   * arrival is real in the only sense the medium allows — the player drove for
   * it.
   */
  waypoint?: {
    /** What the HUD calls it, e.g. "PORT GELLHORN". */
    label: string
    /** Display metres to cover. */
    distanceM: number
    /** Cruise speed in m/s while driving forward. Default 14. */
    speedMs?: number | undefined
    /** Remaining distance at which the destination APPEARS — the event's first
     *  phase streams while the player is still driving, so the place is on the
     *  horizon well before the turn-in. Default min(200, distanceM * 0.35). */
    approachM?: number | undefined
  } | undefined
  /**
   * PULSE the drive rather than holding it for the whole event: applied on
   * press and released after this many ms while the event keeps playing. A
   * brief flick of a channel — tilt the look up for half a second to cue a
   * raised arm, then return to normal framing while the prompt holds the pose.
   */
  drivePulseMs?: number | undefined
  /**
   * The outcome line the player READS when they take this — what the choice
   * did, or an NPC's reply. Display copy, like a state's; see
   * `SMState.narration` for why it is exempt from the lint suite.
   */
  narration?: string | undefined
  /**
   * Fire this event by itself, this long after the state is entered.
   *
   * A beat that needs no press: pair it with `hidden` so the
   * event does not also sit on the rail as a button nobody should have to find.
   */
  autoAfterMs?: number | undefined
}
/**
 * One step of a mission: what the player is told to do, where it happens, how
 * the doing LOOKS, and the visual proof it landed.
 *
 * An objective is not a record the UI reads and nothing else — it COMPILES
 * (`world/mission.ts`) into the states and events the runtime already plays:
 * the grounded target becomes an anchor chip, the confirmation becomes arrival
 * evidence, the grant becomes a flag in the run's ledger, and the fail branch
 * becomes a sibling transition into a lose ending. That is what makes a quest a
 * quest rather than a checklist drawn over a graph.
 */
export interface SMObjective {
  /** Stable id; also the default flag granted on completion. */
  id: string
  /** The line the player reads ("Find the diving helmet"). */
  text: string
  /** The state it happens in. Created if it does not exist yet. */
  location?: string | undefined
  /** Prose for `location` when the compiler has to create it. */
  base?: string | undefined
  /** Framing + choreography for a newly created `location`. Each scene needs
   *  its OWN framing; a generic inherited one describes the wrong place. */
  camera?: string | undefined
  movement?: string | undefined
  /** How the action LOOKS while it plays — the event's body. Without it the
   *  event streams nothing. */
  action?: string | undefined
  /** A CINEMATIC action: two or more beats, streamed in order. */
  phases?: { base: string; movement?: string; minMs?: number }[] | undefined
  /** The grounded interaction that completes it. `target` becomes the chip on
   *  the live frame; `confirm` becomes the arrival evidence that the action
   *  really landed. Omit for a pure travel step. */
  grounded?: {
    target: string
    targetAliases?: string[]
    confirm?: string
    confirmAliases?: string[]
    proximity?: number
  } | undefined
  /** Prose for the CONSEQUENCE state a verified action lands in — the world
   *  AFTER it. A kill resolves into a new state; it never re-seeds the one that
   *  would respawn what was killed. */
  outcome?: string | undefined
  /** Flag granted on completion (default: the id). */
  grants?: string | undefined
  /** Flags gating it (default: the previous objective's grant — the compiler
   *  chains them into an ordered ledger). */
  requires?: string[] | undefined
  /** Show the action VISIBLE-BUT-LOCKED while gated, with this reason. */
  lockedHint?: string | undefined
  /** A tempting WRONG move available in the same place that ends the run. Every
   *  mission worth playing carries at least one real stake. */
  fail?: { name: string; action: string; outcome: string; title: string; subtitle?: string } | undefined
}

/** Ordered objectives that compile into graph, plus the record the quest panel
 *  reads. The unit that ties quest UI, state graph, flag ledger and grounding
 *  together. */
export interface SMMission {
  id: string
  title: string
  objectives: SMObjective[]
  /** Flag marking the whole mission complete (default: the last grant). */
  complete?: string | undefined
  /**
   * Every noun a detector actually FOUND in the frame this mission was built
   * from — the set its objectives were allowed to ground on.
   *
   * This used to be returned from the call and never persisted, so a stored
   * mission grounded on probe-verified nouns was indistinguishable from one
   * grounded on nouns a model invented. The whole value of that path is the
   * difference, and the evidence for it was discarded when the call returned.
   * Recording it makes the guarantee checkable from the artifact instead of
   * only from a live run — a confirmed value must be distinguishable from an
   * unconfirmed one.
   *
   * Absent means "not built from a probe", NOT "probed and found nothing":
   * an empty array is the second, and `missionGrounding` reports them apart.
   */
  verified?: string[] | undefined
}

/**
 * One beat of a set-piece: a state to enter, and how long to stay.
 *
 * `dwell` is the pacing knob, and the three values are three different kinds of
 * waiting: `settle` holds until the picture stops moving (the physical
 * signature of a shot having landed, checked with the same motion evidence a
 * transition's `landWhen` uses), `input` hands control back to the player, and
 * `{ ms }` is a plain timer.
 *
 * There is no `{ chunks: N }` dwell option here, the kind that counts the
 * world model's own latent chunk boundaries: this studio's provider contract
 * exposes no chunk clock, and a dwell that guessed at one would be a timer
 * wearing a better name.
 */
export interface SMSequenceBeat {
  state: string
  dwell?: 'settle' | 'input' | { ms: number } | undefined
}

/**
 * A set-piece: an ordered chain of states played as ONE unit — the UFO arrives,
 * the tank appears, the tank fires, the UFO falls.
 *
 * The member states live in `scene` like any others; this records the grouping,
 * the order and the pacing, which is what lets the runtime WALK it hands-free,
 * an editor show it as one track instead of four loose states, and an agent
 * revise the whole thing rather than a fragment of it.
 */
export interface SMSequence {
  id: string
  title: string
  beats: SMSequenceBeat[]
}

/**
 * The story ABOVE the graph — and, more usefully, the agent's memory of it.
 *
 * The logline says what the world dramatically IS;
 * the arc names the stages it moves through; and `beats` is a running outline
 * of beats authored so far (newest last) — what already happened, so the
 * director doesn't contradict or repeat it.
 *
 * That last clause is the reason this is worth having here. The director was
 * answering every typed action from a blank slate: it can see
 * the graph, so it knows a state called `atrium_dragon` exists, and it has no
 * idea a dragon already smashed through the wall two actions ago. A graph
 * records structure; the story records what HAPPENED.
 */
export interface SMStory {
  /** One sentence: what this world is, dramatically. */
  logline: string
  /** Ordered stages the experience moves through, e.g.
   *  ["arrival", "unease", "escalation", "confrontation", "aftermath"]. */
  arc?: string[] | undefined
  /** What has been authored so far, newest last. */
  beats?: { summary: string; arc?: string | undefined; states?: string[] | undefined; sequence?: string | undefined }[] | undefined
}

/**
 * A pre-rendered clip on a state→state seam.
 *
 * These are for what a world model cannot render: a grab, a death, a
 * body-horror tableau, the loop, and for drift resets. A world model will
 * attempt anything you describe; a cutscene is the author saying "not this —
 * I have footage".
 *
 * The rule that matters most is fail-open: missing/404 skips straight to the
 * re-seed so the world is playable before final art lands. A world under
 * construction has to stay playable, and a clip that has not been made yet
 * must not become a wall.
 *
 * Two fields are deliberately absent, each for a stated reason rather than an
 * oversight:
 *   · `seedFrame` — booting a FRESH session seeded from the clip's last
 *     frame, a true drift reset. The provider contract here has no
 *     reseed-from-image call, so the cut lands as a prompt swap on the running
 *     session instead.
 *   · `audioLeadMs` — there is no audio here to lead with.
 */
export interface SMCutscene {
  /** Stable id, and what a transition's `to` names to trigger it. */
  id: string
  /** What the editor calls it, e.g. "Outside → Lobby". */
  label?: string | undefined
  /** Clip URL. Same-origin recommended; missing is survivable by design. */
  video: string
  /** The state this cut sits AFTER. */
  from: string
  /** The state to land in when it ends. */
  to: string
  /** Caption over the clip — the suite's own words for the memory, so it
   *  reads with the sound off and the narration is on screen while it speaks. */
  subtitle?: string | undefined
  /** Flags that must all be held for this cut to play at all. */
  requires?: string[] | undefined
}

export interface SMScene { states: Record<string, SMState>; events: SMEvent[] }
export interface SMWorld { id?: string | undefined; name?: string | undefined; description?: string | undefined; cover?: string | null | undefined; entrance?: { image?: { label?: string | undefined; src: string } | undefined; state: string } | undefined; scene: SMScene; narrate?: boolean | undefined; introVideo?: string | undefined; introStatic?: boolean | undefined; outro?: { video: string; flag: string; state: string } | undefined; story?: SMStory | undefined; cutscenes?: SMCutscene[] | undefined; sequences?: SMSequence[] | undefined; missions?: SMMission[] | undefined; subject?: string | undefined; styleTail?: string | undefined; [k: string]: unknown }

export interface WorldListItem { id: string; name: string; description?: string | undefined; cover?: string | null | undefined; visibility?: string | undefined; slug?: string | null | undefined; updated_at?: string | undefined }
export interface WorldList { worlds: WorldListItem[]; nextCursor?: string | null | undefined }
export interface Diagnostic { lint: string; severity: 'error' | 'warning' | 'info'; path: string; message: string }
export interface GraphWriteResult { world: SMWorld; diagnostics?: Diagnostic[] | undefined; rev: string; schemaVersion?: string | undefined; [k: string]: unknown }
export interface VersionNode { id: string; parentVersionId: string | null; source?: string | undefined; title?: string | null | undefined; created_at?: string | undefined }
export interface Hotspot { label: string; bbox: number[]; confidence: number; choice_id?: string | null | undefined }

/**
 * The store's operation vocabulary, in two registers.
 *
 * COARSE — `update_state`/`update_event` take a patch of many
 * fields at once, which is the shape an editor FORM produces (one save, many
 * fields changed).
 *
 * FINE — one narrow op per concern. These
 * exist because the writer that matters most is a language model, and
 * `set_event_anchor {event, label}` is a shape a model gets right far more
 * often than a free-form patch; because a narrow op can be validated exactly at
 * the boundary instead of against a union of everything; and because an action
 * log of fine ops says what happened without diffing the world.
 *
 * Both registers route through the SAME helpers in the store, so a field can
 * only be dropped in one place.
 *
 * One op is deliberately absent: `set_slot_fill`, which fills a typed
 * slot in a factored field. Fields here are plain prose, so there is no slot
 * to fill, and that absence is the only one.
 */
export const PUBLIC_OPS = ['add_state', 'update_state', 'delete_state', 'add_event', 'update_event', 'delete_event', 'set_entrance', 'add_variant', 'remove_variant', 'add_mission', 'add_sequence', 'remove_sequence', 'set_story', 'add_story_beat', 'add_cutscene', 'remove_cutscene', 'set_narrate', 'set_intro', 'set_outro', 'set_field', 'set_event_field', 'add_transition', 'add_override', 'rename_state', 'remove_state', 'remove_event', 'set_state_ending', 'set_event_kind', 'set_event_drive', 'set_event_hotkey', 'set_event_phases', 'set_event_anchor', 'set_event_grants', 'set_event_requires', 'set_event_locked_hint', 'set_variant_field', 'set_subject'] as const;
export type PublicOp = { op: (typeof PUBLIC_OPS)[number]; [k: string]: unknown };

/**
 * Narrow an unknown value — a CLI `--ops` blob, an agent's JSON — into the store's
 * operation vocabulary. This is the boundary check for a batch write: it rejects
 * anything that is not an array of `{op, …}` whose `op` is one the store actually
 * applies, so an unsupported op fails before a single mutation lands rather than
 * half-way through a graph. The op name is PROVEN a member before it is kept, so
 * nothing here is an unsafe assertion. The store owns this vocabulary, so the
 * narrower for it lives here rather than in every caller that accepts ops.
 */
function isOpsRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isPublicOpName(v: unknown): v is (typeof PUBLIC_OPS)[number] {
  return typeof v === 'string' && (PUBLIC_OPS as readonly string[]).includes(v);
}
export function toPublicOps(raw: unknown): PublicOp[] {
  if (!Array.isArray(raw)) throw new Error('ops must be a JSON array of operations');
  return raw.map((o, i) => {
    if (!isOpsRecord(o)) throw new Error(`op ${i + 1} is not an object`);
    const op = o['op'];
    if (!isPublicOpName(op)) {
      throw new Error(`op ${i + 1} uses an unsupported operation: ${typeof op === 'string' ? op : typeof op}`);
    }
    return { ...o, op };
  });
}

// ── Wire narrowers for the domain types above ────────────────────────────────
// Deep interiors (a state's `camera`, an event's `anchor`, …) are trusted at
// their declared type without inspection — SMState/SMEvent/Diagnostic are
// already loosely typed by design. Only the CONTAINER shape (record vs array)
// is proven.

function asSMScene(v: unknown): SMScene {
  const o = isRecord(v) ? v : {};
  return {
    states: isRecordOf<SMState>(o['states']) ? o['states'] : {},
    events: isArrayOf<SMEvent>(o['events']) ? o['events'] : [],
  };
}

/** The "graph writes -> world record" boundary check: throws if the write
 *  didn't come back with a world object at all. Its `scene` stays lenient —
 *  every graph-write caller reads `.world` and `.rev`, never `.world.scene`
 *  (the editor re-fetches the authoritative scene from getScene). */
function reqSMWorld(o: Record<string, unknown>, key: string, endpoint: string): SMWorld {
  const v = o[key];
  if (!isRecord(v)) fail(endpoint, `response missing object ${key}`);
  return { ...v, scene: asSMScene(v['scene']) };
}

/** Lenient counterpart of `reqSMWorld`, for the operations whose own callers
 *  never read the returned world at all (`edit`'s reply/diagnostics are the
 *  contract; `checkout`'s caller re-fetches via GraphEditor.reload()) — an
 *  absent or malformed one becomes an empty world rather than failing a call
 *  that otherwise succeeded. */
function asSMWorld(v: unknown): SMWorld {
  const o = isRecord(v) ? v : {};
  return { ...o, scene: asSMScene(o['scene']) };
}

function asVersionNode(v: unknown, endpoint: string): VersionNode {
  const o = expectRecord(v, endpoint);
  return {
    id: reqString(o, 'id', endpoint),
    parentVersionId: reqStringOrNull(o, 'parentVersionId', endpoint),
    source: optString(o, 'source'),
    title: optStringOrNull(o, 'title'),
    created_at: optString(o, 'created_at'),
  };
}

export class AlakazamClient {
  baseUrl: string;
  apiKey: string;
  /** Optional hook so the UI can render a live API-call log (method, path, status, ms). */
  onCall?: (entry: { method: string; path: string; status: number; ms: number }) => void;

  constructor(cfg: ClientConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/$/, '');
    this.apiKey = cfg.apiKey;
  }

  /**
   * Fetch + retry only. Returns the parsed body as `unknown` — every public
   * method above narrows it into its own typed result before returning, so
   * NOTHING here claims a shape it hasn't checked.
   */
  private async req(method: string, path: string, opts: { body?: unknown | undefined; ifMatch?: string | undefined; idempotencyKey?: string | undefined } = {}): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    // Transient-failure auto-retry. A 503 is fail-closed (the request was rejected
    // BEFORE any effect — auth/quota backend unavailable), so retrying is safe for
    // any method. A network error (status 0) is only safe to retry for idempotent
    // reads (GET). Bounded exponential backoff so a real outage still surfaces fast.
    const canRetryNetwork = method === 'GET';
    const MAX_ATTEMPTS = 3;
    let lastErr: HttpError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const t0 = performance.now();
      let res: Response;
      try {
        res = await fetch(this.baseUrl + path, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
      } catch (e) {
        this.onCall?.({ method, path, status: 0, ms: Math.round(performance.now() - t0) });
        const message = e instanceof Error ? e.message : String(e);
        const err = new HttpError(0, `network error: ${message}`);
        lastErr = err;
        if (canRetryNetwork && attempt < MAX_ATTEMPTS) { await sleep(250 * attempt); continue; }
        throw err;
      }
      this.onCall?.({ method, path, status: res.status, ms: Math.round(performance.now() - t0) });
      const text = await res.text();
      let json: unknown;
      try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
      if (!res.ok) {
        const body = isRecord(json) ? json : {};
        const errorsJoined = isArrayOf<string>(body['errors']) ? body['errors'].join('; ') : '';
        const detail = optString(body, 'detail') || errorsJoined || `HTTP ${res.status}`;
        const diagnostics = isArrayOf(body['diagnostics']) ? body['diagnostics'] : undefined;
        const err = new HttpError(res.status, detail, diagnostics);
        // 503 = backend transiently unavailable, rejected pre-effect → safe to retry any method.
        if (res.status === 503 && attempt < MAX_ATTEMPTS) { lastErr = err; await sleep(300 * attempt); continue; }
        throw err;
      }
      return json;
    }
    throw lastErr ?? new HttpError(0, 'request failed');
  }

  // ── Worlds lifecycle ───────────────────────────────────────────────────────
  async createWorld(body: { premise?: string | undefined; frame_b64?: string | undefined; frame_url?: string | undefined; name?: string | undefined; pov?: string | undefined; async?: boolean | undefined }, idempotencyKey?: string | undefined): Promise<{ worldId?: string | undefined; slug?: string | undefined; jobId?: string | undefined; status?: string | undefined; cover?: string | undefined; schemaVersion: string }> {
    const endpoint = 'POST /v1/worlds';
    const raw = expectRecord(await this.req('POST', '/v1/worlds', { body, idempotencyKey }), endpoint);
    return {
      worldId: optString(raw, 'worldId'),
      slug: optString(raw, 'slug'),
      jobId: optString(raw, 'jobId'),
      status: optString(raw, 'status'),
      cover: optString(raw, 'cover'),
      // Not read by any caller (see narrow.ts's boundary philosophy) — an
      // absent/malformed schemaVersion should not fail an otherwise-good create.
      schemaVersion: optString(raw, 'schemaVersion') ?? '',
    };
  }

  async getJob(jobId: string): Promise<{ jobId: string; status: string; phase?: string | undefined; progress?: number | undefined; worldId?: string | undefined; error?: string | undefined }> {
    const endpoint = 'GET /v1/jobs/:id';
    const raw = expectRecord(await this.req('GET', `/v1/jobs/${jobId}`), endpoint);
    return {
      jobId: reqString(raw, 'jobId', endpoint),
      // Create.tsx branches on this string directly (TERMINAL.has(status)) — load-bearing.
      status: reqString(raw, 'status', endpoint),
      phase: optString(raw, 'phase'),
      progress: optNumber(raw, 'progress'),
      worldId: optString(raw, 'worldId'),
      error: optString(raw, 'error'),
    };
  }

  async listWorlds(params: { limit?: number | undefined; cursor?: string | undefined } = {}): Promise<WorldList> {
    const q = new URLSearchParams();
    if (params.limit) q.set('limit', String(params.limit));
    if (params.cursor) q.set('cursor', params.cursor);
    const endpoint = 'GET /v1/worlds';
    const raw = expectRecord(await this.req('GET', `/v1/worlds${q.toString() ? `?${q}` : ''}`), endpoint);
    return {
      // Worlds.tsx/Community.tsx read `.worlds` with no fallback — the point of the call.
      worlds: reqArray<WorldListItem>(raw, 'worlds', endpoint),
      nextCursor: optStringOrNull(raw, 'nextCursor'),
    };
  }

  async getWorld(id: string): Promise<SMWorld & { world?: SMWorld | undefined; schemaVersion: string }> {
    const endpoint = 'GET /v1/worlds/:id';
    const raw = expectRecord(await this.req('GET', `/v1/worlds/${id}`), endpoint);
    return {
      ...raw,
      // GraphEditor/Player always overwrite `.scene` with a fresh getScene()
      // before reading it, so it stays lenient here (see asSMWorld's doc).
      scene: asSMScene(raw['scene']),
      world: isRecord(raw['world']) ? asSMWorld(raw['world']) : undefined,
      schemaVersion: optString(raw, 'schemaVersion') ?? '',
    };
  }

  async updateWorld(id: string, patch: { name?: string | undefined; description?: string | undefined; cover?: string | undefined; visibility?: string | undefined }): Promise<WorldListItem & { schemaVersion: string }> {
    const endpoint = 'PATCH /v1/worlds/:id';
    const raw = expectRecord(await this.req('PATCH', `/v1/worlds/${id}`, { body: patch }), endpoint);
    return {
      id: reqString(raw, 'id', endpoint),
      name: reqString(raw, 'name', endpoint),
      description: optString(raw, 'description'),
      cover: optStringOrNull(raw, 'cover'),
      visibility: optString(raw, 'visibility'),
      slug: optStringOrNull(raw, 'slug'),
      updated_at: optString(raw, 'updated_at'),
      schemaVersion: optString(raw, 'schemaVersion') ?? '',
    };
  }

  async deleteWorld(id: string): Promise<{ ok: boolean; deleted: string }> {
    const endpoint = 'DELETE /v1/worlds/:id';
    const raw = expectRecord(await this.req('DELETE', `/v1/worlds/${id}`), endpoint);
    return { ok: reqBoolean(raw, 'ok', endpoint), deleted: reqString(raw, 'deleted', endpoint) };
  }

  async forkWorld(id: string): Promise<{ worldId: string; schemaVersion: string }> {
    const endpoint = 'POST /v1/worlds/:id/forks';
    const raw = expectRecord(await this.req('POST', `/v1/worlds/${id}/forks`), endpoint);
    return { worldId: reqString(raw, 'worldId', endpoint), schemaVersion: optString(raw, 'schemaVersion') ?? '' };
  }

  // ── Graph read ───────────────────────────────────────────────────────────
  async getScene(id: string): Promise<{ states: Record<string, SMState>; events: SMEvent[]; rev: string }> {
    const endpoint = 'GET /v1/worlds/:id/scene';
    const raw = expectRecord(await this.req('GET', `/v1/worlds/${id}/scene`), endpoint);
    return {
      states: reqRecordField<SMState>(raw, 'states', endpoint),
      events: reqArray<SMEvent>(raw, 'events', endpoint),
      rev: reqString(raw, 'rev', endpoint),
    };
  }

  // ── Graph write (deterministic) ──────────────────────────────────────────
  private async graphWrite(method: string, path: string, endpoint: string, opts: { body?: unknown | undefined; ifMatch?: string | undefined } = {}): Promise<GraphWriteResult> {
    const raw = expectRecord(await this.req(method, path, opts), endpoint);
    return {
      ...raw,
      world: reqSMWorld(raw, 'world', endpoint),
      rev: reqString(raw, 'rev', endpoint),
    };
  }

  addState(id: string, body: { id?: string | undefined } & Partial<SMState>, ifMatch?: string | undefined): Promise<GraphWriteResult> {
    return this.graphWrite('POST', `/v1/worlds/${id}/states`, 'POST /v1/worlds/:id/states', { body, ifMatch });
  }
  updateState(id: string, stateId: string, patch: NullablePatch<SMState>, ifMatch?: string | undefined): Promise<GraphWriteResult> {
    return this.graphWrite('PATCH', `/v1/worlds/${id}/states/${encodeURIComponent(stateId)}`, 'PATCH /v1/worlds/:id/states/:stateId', { body: patch, ifMatch });
  }
  deleteState(id: string, stateId: string, ifMatch?: string | undefined): Promise<GraphWriteResult> {
    return this.graphWrite('DELETE', `/v1/worlds/${id}/states/${encodeURIComponent(stateId)}`, 'DELETE /v1/worlds/:id/states/:stateId', { ifMatch });
  }
  addEvent(id: string, body: { kind: 'transition' | 'override'; from: string | string[]; to?: string | undefined; name?: string | undefined; base?: string | undefined; detail?: string | undefined; hotkey?: string | null | undefined }, ifMatch?: string | undefined): Promise<GraphWriteResult> {
    return this.graphWrite('POST', `/v1/worlds/${id}/events`, 'POST /v1/worlds/:id/events', { body, ifMatch });
  }
  updateEvent(id: string, name: string, patch: NullablePatch<SMEvent>, ifMatch?: string | undefined): Promise<GraphWriteResult> {
    return this.graphWrite('PATCH', `/v1/worlds/${id}/events/${encodeURIComponent(name)}`, 'PATCH /v1/worlds/:id/events/:name', { body: patch, ifMatch });
  }
  deleteEvent(id: string, name: string, ifMatch?: string | undefined): Promise<GraphWriteResult> {
    return this.graphWrite('DELETE', `/v1/worlds/${id}/events/${encodeURIComponent(name)}`, 'DELETE /v1/worlds/:id/events/:name', { ifMatch });
  }
  setEntrance(id: string, body: { state: string; image?: { label?: string | undefined; src: string } | undefined }, ifMatch?: string | undefined): Promise<GraphWriteResult> {
    return this.graphWrite('PATCH', `/v1/worlds/${id}/entrance`, 'PATCH /v1/worlds/:id/entrance', { body, ifMatch });
  }
  /** `strict` is not forwarded: the hosted API already validates the world
   *  server-side at registration, so asking this client to pre-validate would
   *  duplicate a gate that is already there and disagree with it the moment
   *  the doctrines drift. */
  applyOps(id: string, ops: PublicOp[], ifMatch?: string | undefined, _opts?: { strict?: boolean | undefined } | undefined): Promise<GraphWriteResult> {
    return this.graphWrite('POST', `/v1/worlds/${id}/ops`, 'POST /v1/worlds/:id/ops', { body: { ops }, ifMatch });
  }

  // ── Validate / lint / agent ─────────────────────────────────────────────
  async validate(id: string, world?: SMWorld | undefined): Promise<{ ok: boolean; world?: SMWorld | undefined; diagnostics: Diagnostic[] }> {
    const endpoint = 'POST /v1/worlds/:id/validate';
    const raw = expectRecord(await this.req('POST', `/v1/worlds/${id}/validate`, { body: world ? { world } : {} }), endpoint);
    return {
      // RemoteWorldStore reads this as `res.ok !== false` (an absent ok already
      // read as "ok" before this boundary existed) — `?? true` keeps that exact
      // reading rather than introducing a new 502 for a case nothing broke on.
      ok: optBoolean(raw, 'ok') ?? true,
      world: isRecord(raw['world']) ? asSMWorld(raw['world']) : undefined,
      // Lint.tsx already reads this as `res.diagnostics ?? []` — same fallback here.
      diagnostics: defaultArray<Diagnostic>(raw, 'diagnostics'),
    };
  }

  async lint(id: string, world?: SMWorld | undefined): Promise<{ ok: boolean; diagnostics: Diagnostic[]; promptBudget: number }> {
    const endpoint = 'POST /v1/worlds/:id/lint';
    const raw = expectRecord(await this.req('POST', `/v1/worlds/${id}/lint`, { body: world ? { world } : {} }), endpoint);
    return {
      ok: optBoolean(raw, 'ok') ?? true,
      diagnostics: defaultArray<Diagnostic>(raw, 'diagnostics'),
      // Lint.tsx reads `res.promptBudget` directly, no fallback.
      promptBudget: reqNumber(raw, 'promptBudget', endpoint),
    };
  }

  async edit(id: string, instruction: string, ifMatch?: string | undefined, idempotencyKey?: string | undefined): Promise<{ ok?: boolean | undefined; world: SMWorld; diagnostics: Diagnostic[]; reply: string }> {
    const endpoint = 'POST /v1/worlds/:id/edit';
    const raw = expectRecord(await this.req('POST', `/v1/worlds/${id}/edit`, { body: { instruction }, ifMatch, idempotencyKey }), endpoint);
    return {
      ok: optBoolean(raw, 'ok'),
      // The agent bar never reads `.world` (only reply/diagnostics render;
      // GraphEditor.reload() re-fetches the authoritative graph) — lenient.
      world: asSMWorld(raw['world']),
      diagnostics: defaultArray<Diagnostic>(raw, 'diagnostics'),
      // The agent bar reads `res.reply` directly, no fallback.
      reply: reqString(raw, 'reply', endpoint),
    };
  }

  // ── Versions ─────────────────────────────────────────────────────────────
  async snapshotVersion(id: string, body: { title?: string | undefined; parentVersionId?: string | null | undefined; source?: string | undefined } = {}): Promise<{ versionId: string; version: VersionNode }> {
    const endpoint = 'POST /v1/worlds/:id/versions';
    const raw = expectRecord(await this.req('POST', `/v1/worlds/${id}/versions`, { body }), endpoint);
    // world.version.restore reads `backup.versionId` directly to record it
    // alongside a checkout — load-bearing.
    return { versionId: reqString(raw, 'versionId', endpoint), version: asVersionNode(raw['version'], endpoint) };
  }
  async listVersions(id: string): Promise<{ versions: VersionNode[] }> {
    const endpoint = 'GET /v1/worlds/:id/versions';
    const raw = expectRecord(await this.req('GET', `/v1/worlds/${id}/versions`), endpoint);
    // Versions.tsx's buildOrder() reads `.id`/`.parentVersionId` on every entry
    // with no fallback (a Set + a DAG walk), so each entry is narrowed too —
    // still a boundary check, not deep validation: asVersionNode only proves
    // id/parentVersionId, everything else on a VersionNode stays optional.
    return { versions: reqArray<unknown>(raw, 'versions', endpoint).map((v) => asVersionNode(v, endpoint)) };
  }
  async getVersion(id: string, versionId: string): Promise<{ id: string; snapshot: SMWorld }> {
    const endpoint = 'GET /v1/worlds/:id/versions/:versionId';
    const raw = expectRecord(await this.req('GET', `/v1/worlds/${id}/versions/${versionId}`), endpoint);
    // Not read anywhere in the app today (only surfaced via the CLI) — lenient snapshot.
    return { id: reqString(raw, 'id', endpoint), snapshot: asSMWorld(raw['snapshot']) };
  }
  async renameVersion(id: string, versionId: string, title: string): Promise<{ ok: boolean; versionId: string; title: string }> {
    const endpoint = 'PATCH /v1/worlds/:id/versions/:versionId';
    const raw = expectRecord(await this.req('PATCH', `/v1/worlds/${id}/versions/${versionId}`, { body: { title } }), endpoint);
    return { ok: reqBoolean(raw, 'ok', endpoint), versionId: reqString(raw, 'versionId', endpoint), title: reqString(raw, 'title', endpoint) };
  }
  async deleteVersion(id: string, versionId: string): Promise<{ ok: boolean; deleted: string }> {
    const endpoint = 'DELETE /v1/worlds/:id/versions/:versionId';
    const raw = expectRecord(await this.req('DELETE', `/v1/worlds/${id}/versions/${versionId}`), endpoint);
    return { ok: reqBoolean(raw, 'ok', endpoint), deleted: reqString(raw, 'deleted', endpoint) };
  }
  async diffVersions(id: string, a: string, b: string): Promise<{ a: string; b: string; states: { added: string[]; removed: string[]; changed: string[] }; events: { added: string[]; removed: string[]; changed: string[] } }> {
    const endpoint = 'GET /v1/worlds/:id/versions/:a/diff/:b';
    const raw = expectRecord(await this.req('GET', `/v1/worlds/${id}/versions/${a}/diff/${b}`), endpoint);
    const group = (key: string) => {
      // Versions.tsx's DiffSection renders `.added/.removed/.changed` directly
      // (`.length`, `.map`) with no fallback — each is load-bearing.
      const g = expectRecord(raw[key], endpoint);
      return { added: reqArray<string>(g, 'added', endpoint), removed: reqArray<string>(g, 'removed', endpoint), changed: reqArray<string>(g, 'changed', endpoint) };
    };
    return { a: reqString(raw, 'a', endpoint), b: reqString(raw, 'b', endpoint), states: group('states'), events: group('events') };
  }
  async checkout(id: string, versionId: string, ifMatch?: string | undefined): Promise<{ world: SMWorld; rev: string }> {
    const endpoint = 'POST /v1/worlds/:id/checkout';
    const raw = expectRecord(await this.req('POST', `/v1/worlds/${id}/checkout`, { body: { versionId }, ifMatch }), endpoint);
    // VersionsPanel.doCheckout re-fetches via GraphEditor.reload() and never
    // reads the returned world — lenient, matching `edit`.
    return { world: asSMWorld(raw['world']), rev: reqString(raw, 'rev', endpoint) };
  }

  // ── Sessions (play / embed) ──────────────────────────────────────────────
  async mintSession(body: { worldId: string; playerIdentity?: string | undefined; origin?: string | undefined; ttlSeconds?: number | undefined }): Promise<{ token: string; expiresIn: number; worldId: string; slug: string | null; jti: string }> {
    const endpoint = 'POST /v1/sessions/token';
    const raw = expectRecord(await this.req('POST', '/v1/sessions/token', { body }), endpoint);
    return {
      // Every caller (Worlds.tsx, Community.tsx, the alakazam provider) reads
      // `.token` and only `.token` — the one field that has to be real.
      token: reqString(raw, 'token', endpoint),
      expiresIn: optNumber(raw, 'expiresIn') ?? 0,
      worldId: optString(raw, 'worldId') ?? body.worldId,
      slug: optStringOrNull(raw, 'slug') ?? null,
      jti: optString(raw, 'jti') ?? '',
    };
  }
  /** The embed URL for a world, given a freshly-minted session token + the embed host.
   *  (The session token already carries the worldId; the extra arg keeps call sites
   *  self-documenting.) */
  embedUrl(embedHost: string, token: string) { return `${embedHost.replace(/\/$/, '')}/embed.html?token=${encodeURIComponent(token)}`; }

  // ── Vision / grounding (interactive objects) ─────────────────────────────
  async perceive(body: { frame_b64: string; room_name?: string | undefined; room_description?: string | undefined }): Promise<{ summary: string; visible: string[]; affordances: string[]; exits: string[] }> {
    const endpoint = 'POST /v1/perceive';
    const raw = expectRecord(await this.req('POST', '/v1/perceive', { body }), endpoint);
    return {
      // Vision.tsx renders this behind a truthy check (`perception.summary &&`) — lenient.
      summary: optString(raw, 'summary') ?? '',
      // visible/affordances/exits are all read with `.length`/`.map` and no
      // guard in Vision.tsx — an absent one would crash the render today;
      // throwing here turns that crash into a clean failed request.
      visible: reqArray<string>(raw, 'visible', endpoint),
      affordances: reqArray<string>(raw, 'affordances', endpoint),
      exits: reqArray<string>(raw, 'exits', endpoint),
    };
  }
  async groundObjects(body: { frame_b64: string; labels: string[] }): Promise<{ hotspots: Hotspot[] }> {
    const endpoint = 'POST /v1/ground/objects';
    const raw = expectRecord(await this.req('POST', '/v1/ground/objects', { body }), endpoint);
    // Vision.tsx reads `.hotspots` directly (`.length`, stored as-is) — load-bearing.
    return { hotspots: reqArray<Hotspot>(raw, 'hotspots', endpoint) };
  }
  async seedFrame(body: { prompt: string; pov?: string | undefined; mood?: string | undefined; style?: string | undefined }): Promise<{ imageBase64: string; mimeType: string; url: string; prompt: string; art_style?: string | undefined }> {
    const endpoint = 'POST /v1/seed-frame';
    const raw = expectRecord(await this.req('POST', '/v1/seed-frame', { body }), endpoint);
    return {
      // Create.tsx reads `r.imageBase64` straight into state — load-bearing.
      imageBase64: reqString(raw, 'imageBase64', endpoint),
      // Create.tsx already falls back with `r.mimeType || 'image/png'` — lenient.
      mimeType: optString(raw, 'mimeType') ?? '',
      // Create.tsx reads `r.url` as the fallback preview source — load-bearing.
      url: reqString(raw, 'url', endpoint),
      // Not read by Create.tsx (SeedView carries only b64/mime/url) — lenient.
      prompt: optString(raw, 'prompt') ?? '',
      art_style: optString(raw, 'art_style'),
    };
  }

  // ── Usage ────────────────────────────────────────────────────────────────
  async usage(): Promise<{ day: string; usage: Record<string, number>; caps: Record<string, number> }> {
    const endpoint = 'GET /v1/usage';
    const raw = expectRecord(await this.req('GET', '/v1/usage'), endpoint);
    return {
      // Account.tsx renders `data.day` directly — load-bearing.
      day: reqString(raw, 'day', endpoint),
      // Account.tsx does `Object.keys(caps)` / `data.usage[kind]` — the
      // CONTAINERS must exist; individual number values stay unchecked, the
      // same loose treatment SMState and SMEvent get.
      usage: reqRecordField<number>(raw, 'usage', endpoint),
      caps: reqRecordField<number>(raw, 'caps', endpoint),
    };
  }
}
