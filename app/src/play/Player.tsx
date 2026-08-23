import { useEffect, useRef, useState } from 'react'
import { useClient } from '../studio'
import { AgentBar, runLocalEdit } from '../author'
import { getWorldProvider, getVisionProvider, getLLMProvider, getImageProvider } from '../provider'
import type { WorldCapabilities, WorldSession, VisionProvider, DetectedBox } from '../provider'
import { CapabilityBadge } from '../provider'
import { unwrapWorldDoc, campaignFinished, handoffFor, goldenIndex, worldWithVariant, DEFAULT_PROXIMITY } from '../world'
import type { Campaign } from '../world'
import type { ApiError, Diagnostic, SMDrive, SMEvent, SMEventAnchor, SMEventPhase, SMLandWhen, SMCutscene, SMMission, SMSequence, SMState, SMWorld } from '../world'
import { missionProgress } from '../world'
import { Button, Muted, Pill, Spinner, TextInput } from '../theme'
import { Chips } from './Chips'
import { PlayInspector } from './Inspector'
import { beatBarNote, emptyTrack, legalBeats, lockedBeats, observe } from './anchors'
import type { AnchorTrack } from './anchors'
import { autoEligible, describeGate, evidenceMet, gateBudget, measureFrame } from './evidence'
import type { FrameSample } from './evidence'
import { emptyRecord, markTime, promptForBeat, replayGate } from './episode'
import { AXIS_STOP_TOKEN, DRIVE_KEYS, LOOK_KEYS, MOVE_KEYS } from './keys'
import { DriveKeys } from './DriveKeys'
import { AMBIENT, ambientWait, nextAmbient, promptWithAmbient } from './ambient'
import { DRIVE_RELEASE, autopilotTokens, centeringLook, driveTokens, hasDrive, tickOdometer, waypointHud } from './drive'
import type { WaypointSpec } from './drive'
import { sequencePlan, sequencesFrom, settleSatisfiable } from './sequence'
import { resolveDestination, CUTSCENE_TIMEOUT_MS } from './cutscene'
import { terminalSystem } from './terminal'
import { narrationFor } from './narrate'
import { bootAfterIntro, outroDue } from './bookends'
import type { TerminalSpec } from './terminal'
import { parseWitnessAnswer, witnessOf, witnessSystem, witnessClipPackOf, memoryIdOf } from './witness'
import type { WitnessAnswer } from './witness'
import { speak } from './voice'
import type { VoicePart } from './voice'
import type { PlannedBeat } from './sequence'
import type { EpisodeRecord } from './episode'
import { contextFrom, directAction, isChoicePoint, rewindTargetFor } from './director'

/**
 * Keyboard → command token. WASD MOVES, the arrows LOOK — the split this
 * player uses (`MOVE_KEYS` / `LOOK_KEYS`) and, until now, the thing this
 * player was missing.
 *
 * The arrows used to strafe, so there was no way to TURN. That is not a
 * cosmetic gap: an anchored chip arms only when its object is in FRONT of the
 * camera, and an off-axis one displays "◀ turn to face" — an instruction the
 * player could not carry out. Measured on a live session: 91 seconds of pressing
 * the arrows and the chip never armed, because strafing past an object does not
 * point the camera at it. The transport had `set_look_horizontal` the whole
 * time; nothing was sending it.
 */
// The drive tables live in `keys.ts` so the player and the on-screen caps read
// ONE table — they would disagree the moment there were two.

/** Samples kept per channel. ~3 Hz of frames is an hour of play, and the gate
 *  questions worth asking are about the recent past. */
const EPISODE_CAP = 10_000

/** How long the boot drive continues an intro's motion before letting go. */
const INTRO_DRIVE_MS = 2500

/** THE TAKE's earpiece — a cast voice with real delivery direction, not a
 *  default TTS reading lines flat. This is the answer to "how is it supposed
 *  to be said": it is written down, here, and sent with every line. */
const EARPIECE = {
  cast: true,
  voice: 'sage',
  instructions:
    'You are a veteran heist operator speaking softly into a radio earpiece during a live casino job. ' +
    'Low, steady, unhurried, casino-cool. Close-mic, lightly compressed radio tone, slight smile in the voice ' +
    'when the line is wry. Never theatrical — the situation is the drama; you are the calm in it.',
}

/** How often the servo looks, and how long a correction is held. Slower than
 *  the chip probe: a camera correction every few seconds reads as a drifting
 *  operator, and one every 700ms reads as a nervous one. */
const SERVO_TICK_MS = 3000
const SERVO_PULSE_MS = 450
/** How loud a scene's ambience loop sits under the music bed. */
const AMBIENCE_VOLUME = 0.22

/**
 * One authored event, reduced to what actually gets pushed into the world.
 *
 * `kind` is the important field. A transition MOVES the machine, so it goes out
 * as a `state` event carrying the destination id — that is what a backend keys
 * off to change what it is drawing, and what the WebSocket protocol documents as
 * the state-entry message. An override does not move anything, so it stays a
 * `prompt`. Sending everything as `prompt` (the first version of this) left the
 * state machine frozen: the mock's HUD sat on its initial state name forever
 * while the log filled up with beats, which is a convincing imitation of a
 * working state machine and a total misrepresentation of one.
 */
interface Beat {
  name: string
  label: string
  kind: 'state' | 'prompt'
  text: string
  /** Destination state, for a transition. */
  stateId?: string | undefined
  /** States this beat is legal from. Empty means "from anywhere". */
  from: string[]
  /** Flags that must ALL be held before this beat is offered. */
  requires?: string[] | undefined
  /** Flags this beat grants when it lands. */
  grants?: string[] | undefined
  /** Fires once per run, then is gone. */
  oneShot?: boolean | undefined
  /** Shown, disabled, with this reason while its flags are unmet. */
  lockedHint?: string | undefined
  hotkey?: string | undefined
  /** A detected object this beat can be fired from, instead of only the rail. */
  anchor?: SMEventAnchor | undefined
  /** Choreography: the move told one beat at a time, streamed in order. */
  phases?: SMEventPhase[] | undefined
  /** Arrival evidence — what the picture has to show before the destination
   *  state is allowed to land. */
  landWhen?: SMLandWhen | undefined
  /** The event's own framing and choreography while it plays, appended to its
   *  prose — a move through a door is not framed like either room. */
  camera?: string | undefined
  movement?: string | undefined
  /** Floor on how long this streams before the destination may land. */
  minPlayMs?: number | undefined
  /** Fires itself this long after the state is entered. */
  autoAfterMs?: number | undefined
  /** The line the player READS when they take this — not sent to the model. */
  narration?: string | undefined
  /** Controls this move presses while it plays. */
  drive?: SMDrive | undefined
  /** A destination the player DRIVES to — see `play/drive.ts`'s odometer. */
  waypoint?: WaypointSpec | undefined
  /** A console in the world, typed into rather than pressed. */
  terminal?: TerminalSpec | undefined
  /** …released after this long instead of when the move lands. */
  drivePulseMs?: number | undefined
}

// ─── Arcade layer: interactive-objects hotspots ────────────────────────────
//
// An event can carry `anchor:{label,aliases}` and the studio can author it,
// but until now nothing at play time ever looked at it — every beat was
// exposed only as a rail button or a hotkey. This is the difference between a
// world you drive with a menu and a world you point at.
// These labels are grounded at authoring time against the real seed frame, so
// the anchor vocabulary stays plain, concrete nouns a detector can actually
// hit ("the bench", never "a place of respite") — which is exactly what makes
// resolving them against a LIVE frame at play time a reasonable thing to
// attempt at all.
//
// `getVisionProvider`/`VisionProvider`/`DetectedBox` are the vision axis's own
// contract (`../provider`, `src/provider/vision/moondream.ts` — boxes already
// 0..1 normalised). Like every other axis, `getVisionProvider` never
// returns null — `isConfigured()` is the gate — so a fresh clone with no
// Moondream key/local URL set gets a real adapter whose `isConfigured()` is
// false, and the effect below no-ops immediately: OFF by the same contract
// every other provider already uses, not a bespoke flag for this one layer.
// That is also why this costs nothing against `tests/no-key.spec.ts`'s "no
// vendor request escapes a keyless clone" assertion.

/** A scene can teach its own verb — the bike rides, the rooms walk. This reads
 *  the state's hudLine when it has one, so the caller can fall back to the
 *  world's line. Typed by narrowing, not assertion: the doc's index signature
 *  is `unknown` and a cast would hide a field that stopped being a string. */
function storyHudLine(world: SMWorld | null, stateId: string | null): string | undefined {
  const state = world?.scene.states[stateId ?? '']
  const raw = state ? Object.getOwnPropertyDescriptor(state, 'hudLine')?.value : undefined
  return typeof raw === 'string' ? raw : undefined
}

/** The biggest of a detect call's boxes: one open-vocab query can return
 *  several candidates, and the largest is the one most likely to be the
 *  actual named object rather than a stray match.
 *
 *  When the probe MEASURED an aspect band for this object at authoring time
 *  (`expectedAspect`, written only for objects that collided with a neighbour),
 *  boxes outside it are dropped first — that band exists precisely to tell two
 *  objects one label hits apart, and using it here is the whole reason it was
 *  measured. */
function pickVisionBox(boxes: DetectedBox[], expect?: { min: number; max: number } | undefined): DetectedBox | undefined {
  const candidates = expect
    ? boxes.filter((b) => {
        const w = Math.max(0, b.xMax - b.xMin)
        const h = Math.max(0, b.yMax - b.yMin)
        if (h <= 0) return false
        const ratio = w / h
        return ratio >= expect.min && ratio <= expect.max
      })
    : boxes
  return candidates.reduce<DetectedBox | undefined>((best, b) => {
    const area = Math.max(0, b.xMax - b.xMin) * Math.max(0, b.yMax - b.yMin)
    const bestArea = best ? Math.max(0, best.xMax - best.xMin) * Math.max(0, best.yMax - best.yMin) : -1
    return area > bestArea ? b : best
  }, undefined)
}

/**
 * Grab whatever the provider is currently drawing into `node`, downscaled
 * through an offscreen canvas into a JPEG data URL a vision provider can run
 * detection on. Read-only: `node` is the provider-OWNED mount element (see
 * the render comment further down) — this only ever reads it, never appends
 * to or removes from it.
 *
 * A video/canvas painted from a cross-origin source with no CORS headers
 * TAINTS the canvas the instant you read it back (`toDataURL` throws
 * `SecurityError`) — an expected outcome on some provider setups, not a bug,
 * so this degrades to "no frame" rather than throwing through the caller.
 */
/**
 * The picture as NUMBERS, for the free arrival signals (`./evidence.ts`). Small
 * on purpose: 160px wide is far more than a luminance mean or a frame-diff
 * needs, and it keeps a per-tick read off the frame budget. Same tainted-canvas
 * degradation as the JPEG grab below — a cross-origin surface reads as "no
 * pixels", never as an exception through the player.
 */
function readPixels(node: HTMLElement, width = 160): Uint8ClampedArray | null {
  const video = node.querySelector('video')
  const canvas = node.querySelector('canvas')
  const source =
    video instanceof HTMLVideoElement && video.videoWidth > 0
      ? { el: video, w: video.videoWidth, h: video.videoHeight }
      : canvas instanceof HTMLCanvasElement && canvas.width > 0
        ? { el: canvas, w: canvas.width, h: canvas.height }
        : null
  if (!source) return null
  const h = Math.max(1, Math.round((width * source.h) / source.w))
  const off = document.createElement('canvas')
  off.width = width
  off.height = h
  const ctx = off.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  try {
    ctx.drawImage(source.el, 0, 0, width, h)
    return ctx.getImageData(0, 0, width, h).data
  } catch {
    return null
  }
}

type FrameGrab = { ok: true; b64: string } | { ok: false; reason: 'no-picture' | 'unreadable' }

function captureFrameB64(node: HTMLElement): FrameGrab {
  const video = node.querySelector('video')
  const canvas = node.querySelector('canvas')
  const source =
    video instanceof HTMLVideoElement && video.videoWidth > 0
      ? video
      : canvas instanceof HTMLCanvasElement && canvas.width > 0
        ? canvas
        : null
  // NOTHING HAS PAINTED is not the same failure as PAINTED BUT UNREADABLE, and
  // conflating them produced a lie on screen: a world whose model had not sent
  // a first frame yet was told its browser had tainted the canvas, sending
  // whoever read it after a CORS problem that did not exist.
  if (!source) return { ok: false, reason: 'no-picture' }
  const w = source instanceof HTMLVideoElement ? source.videoWidth : source.width
  const h = source instanceof HTMLVideoElement ? source.videoHeight : source.height
  if (w <= 0 || h <= 0) return { ok: false, reason: 'no-picture' }
  const off = document.createElement('canvas')
  off.width = w
  off.height = h
  const ctx = off.getContext('2d')
  if (!ctx) return { ok: false, reason: 'unreadable' }
  try {
    ctx.drawImage(source, 0, 0, w, h)
    return { ok: true, b64: off.toDataURL('image/jpeg', 0.7) }
  } catch {
    return { ok: false, reason: 'unreadable' } // tainted canvas — degrade, never crash the player
  }
}

/**
 * Full-screen player, driven by whichever world provider is configured.
 *
 * This used to mint an Alakazam token and mount that vendor's iframe, full stop.
 * Now it asks the registry for the active provider — your own Reactor key, your
 * own WebSocket endpoint, the hosted runtime, or the offline mock — and mounts
 * whatever that provider renders into. The modal does not know or care which.
 *
 * The capability row is shown HERE rather than only in Settings, because play
 * time is when it matters: if the backend cannot take authored events, this is
 * the screen where someone would otherwise sit and wonder why their state
 * machine changes nothing on screen.
 */
export function PlayModal({
  worldId,
  onClose,
  campaignId,
  startState,
  variant,
  locked,
}: {
  worldId: string
  onClose: () => void
  /** A deployed demo is a cinema, not a tab in the studio: locked removes
   *  every path back out — no Close button, no Esc — because behind the
   *  player is an authoring surface whose Settings shows real keys. */
  locked?: boolean
  /** Play this world as one ACT of a campaign: when a state hands off, the next
   *  act boots here with the flags its edge carries. */
  campaignId?: string | undefined
  /** Boot into this state rather than the entrance. */
  startState?: string | undefined
  /** …with that state's alternate prompt swapped in — the B side of an A/B, on
   *  the SAME entrance seed, so the comparison isolates the prose. */
  variant?: string | undefined
}) {
  const { store, providers, tools } = useClient()
  // THE ACT. In a campaign the world under the player CHANGES mid-session, so
  // the id the session is built from is state, not the prop. Everything below
  // reads `actWorldId`; the prop is only where it starts.
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [actId, setActId] = useState<string | null>(null)
  const [actWorldId, setActWorldId] = useState(worldId)
  const [handoffNote, setHandoffNote] = useState<string | null>(null)
  /** Set when the act the player is standing in ends the run here. */
  const [deadEnd, setDeadEnd] = useState<string | null>(null)
  /** The act's own entrance, read at connect — the hand-off guard needs it and
   *  must not read a stale render's copy. */
  const entranceRef = useRef<string | null>(null)
  /**
   * THE EPISODE. What this session actually showed — the frames sampled for
   * arrival evidence, the detect calls made for chips, and a mark whenever a
   * beat fires or a state lands. A ref, not state: it is appended to from
   * timers outside React's cycle, and nothing renders on every sample.
   */
  const recordRef = useRef<EpisodeRecord | null>(null)
  const t0Ref = useRef(0)
  /** How much has been recorded, for the inspector. Sampled on a timer rather
   *  than set per frame: the record is appended to ~3 times a second and a
   *  re-render per sample would be a cost paid for a number nobody reads that
   *  fast. It is also the PROVENANCE of every gate verdict below it — a verdict
   *  computed over an empty record reads exactly like one computed over a real
   *  session, which is a difference an author has to be able to see. */
  const [episodeSize, setEpisodeSize] = useState({ frames: 0, detects: 0 })
  const mountRef = useRef<HTMLDivElement | null>(null)
  const sessionRef = useRef<WorldSession | null>(null)
  const [caps, setCaps] = useState<WorldCapabilities | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('connecting…')
  /** The authored first frame — painted behind the spinner while the session
   *  boots, so "connecting" is a dimmed photograph of the world you're entering
   *  rather than a black rectangle. Cleared as soon as the stream is standing. */
  const [poster, setPoster] = useState<string | null>(null)
  /** STORY MODE — the title card's press is the film's gesture: it arms sound
   *  (music, voice) legally, and nothing of the story shows before it. */
  const [begun, setBegun] = useState(false)
  /** THE ZOOM DOOR — a photograph being picked up, scaling up to fill the
   *  screen while the memory's session boots behind it. When it fades, the
   *  player is standing inside the picture that was just in their hand. */
  const [door, setDoor] = useState<{ src: string; id: number } | null>(null)
  const [doorDone, setDoorDone] = useState(false)
  const doorIdRef = useRef(0)
  /** THE AMBIENCE — a scene's own sound (lapping water, street birds, kitchen
   *  clatter) as a loop under the bed, chosen per state from the world doc.
   *  Reference first because duckMusic, defined above the state, reads it. */
  const ambienceRef = useRef<HTMLAudioElement | null>(null)
  const [beats, setBeats] = useState<Beat[]>([])
  const [sending, setSending] = useState<string | null>(null)
  /** What the beat in flight is doing right now — which phase, or what evidence
   *  it is still waiting for. The inspector reads it. */
  const [progressNote, setProgressNote] = useState<string | null>(null)
  /** Why the last gated transition landed, when it did not land on evidence. */
  const [landNote, setLandNote] = useState<string | null>(null)
  /** Doctrine errors that stopped this world from opening at all. */
  const [blocked, setBlocked] = useState<Diagnostic[] | null>(null)
  /** Read by the trigger-zone tick, which runs outside React's render cycle. */
  const sendingRef = useRef<string | null>(null)
  sendingRef.current = sending
  /** The other half of "a beat is in flight": a gate being waited out shows a
   *  progress note and sends nothing, so `sending` alone would let an ambient
   *  transient land in the middle of an arrival. */
  const progressRef = useRef<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  // Where the machine is right now. The studio has to hold this itself: the
  // provider is told about state changes, it does not tell us about them.
  const [stateId, setStateId] = useState<string | null>(null)
  // True when the backend promised frames and none have painted (see below).
  const [stalled, setStalled] = useState(false)
  /** Read inside the set-piece walk, which runs across awaits and must not see
   *  the value a render closed over. */
  const stalledRef = useRef(false)
  stalledRef.current = stalled

  // Arcade layer — see the module-scope comment above for what this is and
  // why it degrades to inert rather than erroring. One TRACK per anchored beat
  // (`./anchors`), not one box: the rules that make a chip hittable are all
  // about how a detection relates to the ones before it.
  const [tracks, setTracks] = useState<Record<string, AnchorTrack>>({})
  const [arcadeNote, setArcadeNote] = useState<string | null>(null)
  const availableRef = useRef<Beat[]>([])
  const capsRef = useRef<WorldCapabilities | null>(null)
  const arcadeDetectingRef = useRef(false)
  const arcadeWarnedRef = useRef(false)
  const [probing, setProbing] = useState(false)

  // The authored graph, for the inspector: the traversal and the exact prompt
  // layers are the world's own, not a summary of it.
  const [scene, setScene] = useState<{ states: Record<string, SMState>; events: SMEvent[] }>({ states: {}, events: [] })
  /** A bookend clip on screen: the intro over the boot, or the earned outro. */
  const [bookend, setBookend] = useState<{ kind: 'intro' | 'outro'; video: string } | null>(null)
  const bookendDoneRef = useRef<(() => void) | null>(null)
  /** An outro plays ONCE — replaying a victory the player already had is worse
   *  than not playing it at all. */
  const outroPlayedRef = useRef(false)
  /** The console the player is standing at, if any. */
  const [terminal, setTerminal] = useState<{ beat: string; spec: TerminalSpec } | null>(null)
  const [termLog, setTermLog] = useState<{ who: 'you' | 'it'; text: string }[]>([])
  const [termInput, setTermInput] = useState('')
  const [termBusy, setTermBusy] = useState(false)
  /** A witness replay is streaming on a session of its own: the console (and
   *  the HUD, when the console is closed) offers the way back to the state the
   *  machine still stands in. */
  const [replaying, setReplaying] = useState(false)
  /** Sound is OPT-IN and sticky across re-seeds: the model streams ambient
   *  audio the studio used to hard-mute, but autoplay policy blocks sound
   *  until a gesture, so the default stays silent and this toggle is that
   *  gesture. Each toggle re-applies to whatever video is mounted, because a
   *  re-seed mounts a brand-new element with its own muted=true. */
  const [soundOn, setSoundOn] = useState(false)
  /** The async flows (re-seed, witness replay) outlive renders; they apply the
   *  standing sound choice to a freshly mounted video through this ref. */
  const soundRef = useRef(false)
  /** The noir bed — one looping element, created on first unmute (the same
   *  user gesture that unlocks video audio), quiet enough to sit under the
   *  suite's voice. Ducking is a volume dip for the length of a spoken line. */
  const musicRef = useRef<HTMLAudioElement | null>(null)
  function musicEl(): HTMLAudioElement {
    if (!musicRef.current) {
      // The score follows the world: a world may name its own track; a choice
      // film without one runs on the heist clock; the played worlds keep the
      // noir drone.
      const track = (worldRef.current?.['music'] as string | undefined)
        ?? (choiceModeRef.current ? '/music/take.mp3' : '/music/noir.mp3')
      const el = new Audio(track)
      el.loop = true
      // A BED, not a soundtrack: the voice and the world's own audio both sit
      // above it. Too quiet to notice, too present to remove.
      el.volume = 0.12
      musicRef.current = el
    }
    return musicRef.current
  }
  function toggleSound(): void {
    const next = !soundOn
    setSoundOn(next)
    soundRef.current = next
    const v = mountRef.current?.querySelector('video')
    if (v) {
      v.muted = !next || choiceModeRef.current
      // World audio at half — ambience under the voice, never over it.
      v.volume = 0.5
      if (next) void v.play().catch(() => {})
    }
    const m = musicEl()
    if (next) void m.play().catch(() => {})
    else m.pause()
  }
  /** Nearly silence the bed while the suite speaks, restore after. The
   *  AMBIENCE ducks with it — a scene's water and laughter sit under Ellen's
   *  voice, never over it. */
  function duckMusic(on: boolean): void {
    const m = musicRef.current
    if (m) m.volume = on ? 0.03 : 0.12
    const a = ambienceRef.current
    if (a) a.volume = on ? 0.05 : AMBIENCE_VOLUME
  }
  /** STORY MODE — a choice-driven film (THE TAKE): the world's own audio is
   *  muted for good (the recorded voice-overs and the bed carry the sound),
   *  narrations are spoken aloud, and choices render as big cards. The flag
   *  rides the open world schema. */
  const [choiceMode, setChoiceMode] = useState(false)
  const choiceModeRef = useRef(false)
  /** Abort controllers for re-seeded sessions, so teardown kills those connects
   *  the same way the opening connect dies. */
  const reseedAbortRef = useRef<AbortController | null>(null)
  /** Clips authored onto seams. */
  const [cutscenes, setCutscenes] = useState<SMCutscene[]>([])
  /** The clip playing right now, full-bleed over the picture. */
  const [playingCut, setPlayingCut] = useState<SMCutscene | null>(null)
  /** A clip carries its own recorded voice-over now, so the bed steps aside
   *  for it exactly as it does for the console — and a console line that is
   *  still finishing while a clip starts must not un-duck the bed under it. */
  const playingCutRef = useRef<SMCutscene | null>(null)
  useEffect(() => { playingCutRef.current = playingCut; duckMusic(!!playingCut) }, [playingCut])
  /** Which physical keys are down, for the on-screen caps. The effect's own
   *  `held` set is a closure the render cannot see. */
  const [heldCodes, setHeldCodes] = useState<ReadonlySet<string>>(new Set())
  /** Which ambient line showed last, so the next one is never the same. */
  const ambientLastRef = useRef(-1)
  /** Resolves the wait when the clip ends, errors, or times out — whichever
   *  comes first, which is what makes a missing clip survivable. */
  const cutDoneRef = useRef<(() => void) | null>(null)
  /** The world's missions, if it carries any — the quest panel reads them. */
  const [missions, setMissions] = useState<SMMission[]>([])
  /** Set-pieces: ordered chains of states played as one unit. */
  const [sequences, setSequences] = useState<SMSequence[]>([])
  /** Which set-piece is walking, and where in it — a cinematic that gives no
   *  sign it is playing reads as a world that has stopped responding. */
  const [playingSeq, setPlayingSeq] = useState<{ title: string; at: number; of: number } | null>(null)
  /** Every state entered this session, in order. */
  const [trail, setTrail] = useState<string[]>([])
  /**
   * WHAT THE PLAYER READS. The current state's narration, or the outcome line
   * of the beat they just took — the only prose here that is not a prompt.
   * Held separately from `scene` because it is replaced by an event and then
   * returns to the state's own line, which a derived value cannot express.
   */
  const [narration, setNarration] = useState<string | null>(null)
  /** A narration line arrives, is read, and should then GET OUT OF THE WAY —
   *  a panel that never leaves reads as permanent furniture, and players
   *  started asking what it was. Fresh line → visible for 9s → faded. */
  const [narrationShown, setNarrationShown] = useState(false)
  useEffect(() => {
    if (!narration) { setNarrationShown(false); return }
    setNarrationShown(true)
    const t = window.setTimeout(() => setNarrationShown(false), 9000)
    return () => window.clearTimeout(t)
  }, [narration])
  /** In a choice film the narration IS the earpiece voice — every line the
   *  player reads in the bar is also spoken, over the bed, ducked like every
   *  other spoken line. Never fights a clip: clips carry their own voice. */
  useEffect(() => {
    if (!choiceMode || !narration || !soundRef.current) return
    if (playingCutRef.current) return
    // The cast rides the world: a film's voice is a casting decision, and a
    // heist operator and a grieving daughter are not the same part.
    const part = (worldRef.current?.['voicePart'] as VoicePart | undefined) ?? EARPIECE
    duckMusic(true)
    void speak(narration, providers, part).finally(() => { if (!playingCutRef.current) duckMusic(false) })
    // `narration` is the trigger; providers shift in Settings without a re-read.
    // `soundOn` re-triggers so the OPENING line — set while sound was still
    // off — speaks the moment the title card's begin press arms it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choiceMode, narration, soundOn])
  /** The door HOLDS the zoomed print over the boot, and only begins its fade
   *  when the destination session is standing (status clears) — so a slow
   *  world reads as a photograph held up, not as a cut to a loading screen.
   *  No cleanup on purpose: a cleanup here would cancel the unmount the moment
   *  `doorDone` flips and the effect re-runs — the door would never leave. */
  useEffect(() => {
    if (!door || doorDone || status) return
    setDoorDone(true)
    window.setTimeout(() => setDoor(null), 1000)
  }, [door, doorDone, status])
  /** THE SCENE'S OWN SOUND. Each state may name an ambience loop on the world
   *  doc (`ambience: { stateId: '/ambience/....mp3' }`); standing in a new
   *  state swaps the loop. Missing file or silent start: the bed simply plays
   *  alone, so an absent ambience is never an error. */
  useEffect(() => {
    if (!choiceMode) { ambienceRef.current?.pause(); return }
    const map = worldRef.current?.['ambience'] as Record<string, string> | undefined
    const track = stateId ? map?.[stateId] : undefined
    if (!track) { ambienceRef.current?.pause(); ambienceRef.current = null; return }
    const el = new Audio(track)
    el.loop = true
    el.volume = AMBIENCE_VOLUME
    ambienceRef.current?.pause()
    ambienceRef.current = el
    if (soundRef.current) void el.play().catch(() => {})
    return () => { el.pause() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choiceMode, stateId])
  /** What the DIRECTOR last did, in one line the player can read. */
  const [directNote, setDirectNote] = useState<string | null>(null)
  /** The world document, for the few things that are facts about the WORLD
   *  rather than the scene — `narrate`, the style tail the derivation strips. */
  const worldRef = useRef<SMWorld | null>(null)
  /** The scene rev, carried for the composer. The director's own writes read
   *  their own fresh rev, so this is never the thing that guards them. */
  const [rev, setRev] = useState('')
  /** States left by two or more legal doors — the ones worth going back to. */
  const choicePointsRef = useRef<string[]>([])
  const [rewindTarget, setRewindTarget] = useState<string | null>(null)
  /**
   * The run's flag ledger. `requires`/`grants`/`oneShot` were stored, authored
   * by the kernel, drawn on the canvas and policed by a doctrine rule
   * (`unreachable-require`) — while the player evaluated NONE of them, so a
   * locked door opened for anyone and a one-shot fired forever. A rule over a
   * mechanic nobody runs is decorative; this is the mechanic.
   */
  const [flags, setFlags] = useState<Set<string>>(() => new Set())
  const [used, setUsed] = useState<Set<string>>(() => new Set())
  /** A drive key is down — the runtime is on the DYNAMIC layer variants. */
  const [moving, setMoving] = useState(false)
  /** FORWARD specifically, which is the only direction that closes a distance.
   *  A ref because the odometer ticks on a timer, outside React's cycle. */
  const forwardRef = useRef(false)
  /** Metres left on each waypoint event, by name. */
  const [odometer, setOdometer] = useState<Record<string, number>>({})
  /** A LOOK key is down. Its own register, because the camera moving and the
   *  subject moving are different things to be told about. */
  const [looking, setLooking] = useState(false)
  const [paused, setPaused] = useState(false)
  const pausedRef = useRef(false)
  pausedRef.current = paused
  /** The inspector is an AUTHORING lens (live graph, prompt layers); a player
   *  wants the picture, not the machinery. Off by default — the ▦ button
   *  brings it back in one click. */
  const [showInspector, setShowInspector] = useState(false)
  const [mountEl, setMountEl] = useState<HTMLElement | null>(null)

  /** The campaign, when playing one. Loaded once; the acts' worlds are read
   *  per act, so editing act three does not stale the graph. */
  useEffect(() => {
    if (!campaignId) return
    let alive = true
    void store.getCampaign(campaignId).then(
      (c) => {
        if (!alive) return
        setCampaign(c)
        setActId(c.graph.acts.find((a) => a.worldId === actWorldId)?.actId ?? c.graph.start)
      },
      () => { if (alive) setHandoffNote('this campaign could not be read — playing the world on its own') },
    )
    return () => { alive = false }
    // Only on mount/campaign change: `actWorldId` moves as the campaign plays,
    // and re-reading the graph on every act would fight the hand-off below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, store])

  useEffect(() => {
    let alive = true
    const controller = new AbortController()
    setCaps(null)
    setError(null)
    setBeats([])
    setSendError(null)
    setStatus('connecting…')
    recordRef.current = emptyRecord(actWorldId, new Date().toISOString())
    // THE INTRO COVERS THE BOOT — it does not delay it. The session starts
    // underneath, so by the clip's last frame the stream is already running
    // and the cut is invisible: the entrance seed is authored as the video's
    // last frame. Put up whatever the store already knows about before the
    // first read, so the connect happens behind it.
    void store.getWorld(actWorldId).then((doc) => {
      if (!alive) return
      const intro = unwrapWorldDoc(doc).introVideo
      if (intro) setBookend({ kind: 'intro', video: intro })
    }).catch(() => {})
    t0Ref.current = performance.now()

    void (async () => {
      try {
        const provider = getWorldProvider(providers)

        // Read the authored world BEFORE connecting.
        //
        // This modal used to call connect({ worldId }) and nothing else: no
        // opening prompt, no first frame, and no path that ever reached
        // sendEvent. The world you had just written was not sent to the world
        // model at ALL — every provider opened on a generic session, and the
        // capability warning about backends that ignore authored events was
        // guarding a code path that did not exist. The mock said so on screen,
        // in as many words: "no prompt — the studio sent none for this world".
        // THE GATE. Checking before `connect()` means a broken world never
        // opens a session — a world model is metered, and the honest failure
        // is free.
        const verdict = await store.validate(actWorldId).catch(() => null)
        if (!alive) return
        if (verdict && verdict.available && !verdict.ok) {
          setBlocked(verdict.diagnostics)
          return
        }

        // THE CAMPAIGN'S OWN LINTS, before a session opens. Six rules — dangling
        // edges, an unreachable act, a broken golden thread, a loop that can
        // never progress — existed and were run by NOTHING: a campaign could
        // be played straight into an infinite loop with every check passing,
        // because no check was asked.
        //
        // Checked here for the same reason the doctrine is: a world model is
        // metered, and refusing before `connect()` is free.
        if (campaignId) {
          const camp = await store.lintCampaign(campaignId).catch(() => null)
          if (!alive) return
          if (camp && !camp.ok) {
            setBlocked(camp.diagnostics.map((d) => ({
              lint: d.rule,
              severity: d.severity,
              path: d.actId ? `acts.${d.actId}` : 'campaign',
              message: d.message,
            })))
            return
          }
        }

        const opening = await readOpening(store, actWorldId, startState, variant).catch(() => null)
        if (!alive) return
        if (opening) {
          setBeats(opening.beats)
          setStateId(opening.stateId ?? null)
          entranceRef.current = opening.stateId ?? null
          setNarration(opening.narration ?? null)
          worldRef.current = opening.world
          choiceModeRef.current = opening.world?.['choiceMode'] === true
          setChoiceMode(choiceModeRef.current)
          setPoster(opening.firstFrameUrl ?? null)
          setScene(opening.scene)
          setMissions(opening.missions)
          setSequences(opening.sequences)
          setCutscenes(opening.cutscenes)
          setRev(opening.rev)
          setTrail(opening.stateId ? [opening.stateId] : [])
        }

        // A CHOICE FILM DOES NOT OPEN ITS SESSION UNTIL BEGIN. The title card
        // is free; the GPU is not — a world model is metered from the first
        // frame, so nobody still reading the card is billing anything. begin
        // flips `begun`, this effect re-runs, and the connect happens then.
        if (opening?.world?.['choiceMode'] === true && !begun) {
          setStatus('')
          return
        }

        // Capacity is a wave, not a verdict: a 429 "no available capacity" at
        // boot is usually free again seconds later, and surfacing it as a dead
        // error makes a playable world read as broken. Two quiet retries first.
        let session: WorldSession | null = null
        for (let attempt = 1; session === null; attempt++) {
          try {
            session = await provider.connect({
              worldId: actWorldId,
              prompt: opening?.prompt,
              firstFrameUrl: opening?.firstFrameUrl,
              signal: controller.signal,
            })
          } catch (e) {
            const busy = /429|capacity|unavailable|overloaded/i.test(String((e as Error)?.message ?? e))
            if (!busy || attempt >= 3) throw e
            if (!alive) return
            setStatus(`the world is busy — trying again (${attempt + 1}/3)…`)
            await new Promise((r) => setTimeout(r, 4000))
            if (!alive) return
          }
        }
        if (!session) return
        if (!alive) {
          // Closed mid-connect. A session that outlives its modal is a live GPU
          // bill nobody is watching, so dispose the one we just opened.
          void session.dispose()
          return
        }
        sessionRef.current = session
        setCaps(session.capabilities)
        session.onEnded((reason) => { if (alive) setStatus(`session ended: ${reason}`) })
        if (mountRef.current) await session.mount(mountRef.current)
        if (alive) setStatus('')

        // Announce where the machine is standing. Without this the backend is
        // never told which state it opened in — the mock defaulted its readout
        // to the literal string "entrance", an id no authored world contains.
        // No-ops on a provider that cannot take events, by contract.
        if (alive && opening?.stateId) {
          await session
            .sendEvent({ kind: 'state', value: opening.prompt || opening.stateId, stateId: opening.stateId })
            .catch(() => {})
        }
      } catch (e) {
        if (alive) setError(playErrorMessage(e))
      }
    })()

    return () => {
      alive = false
      controller.abort()
      reseedAbortRef.current?.abort()
      // Dispose on EVERY exit path, including unmount and error. Providers hold
      // sockets, GPU sessions and metered time.
      const s = sessionRef.current
      sessionRef.current = null
      if (s) void s.dispose()
    }
  }, [providers, actWorldId, startState, variant, campaignId, begun])

  /**
   * THE METER STOPS WHEN THE PAGE DOES. Closing the tab, or reloading it, does
   * not run the boot effect's cleanup — the socket just vanishes and the GPU
   * session sits server-side until its own timeout, billing all the while.
   * `pagehide` fires on both, so the session is terminated explicitly there.
   */
  useEffect(() => {
    const stop = (): void => {
      const s = sessionRef.current
      sessionRef.current = null
      if (s) void s.dispose().catch(() => {})
    }
    window.addEventListener('pagehide', stop)
    return () => window.removeEventListener('pagehide', stop)
  }, [])

  /**
   * RE-SEED — tear the session down and boot a fresh one on a given prompt and
   * image. The studio's own cutscene notes call this "a true drift reset" and
   * name the reason it was never built: the provider contract has no
   * reseed-from-image call. It does not need one — connect() already takes a
   * first frame, so a re-seed is a dispose + connect, and the graph can reach
   * for it wherever landing on prose alone would lie (a world model steers
   * softly and ignores set_image mid-run, so a scene change that matters is a
   * session change).
   *
   * Disposal happens BEFORE the new connect: the abandoned session stops
   * billing the moment it is dropped, and the new video mounts into an empty
   * element instead of stacking on the old one. A failed re-seed is loud — the
   * player is told and the picture stops, rather than streaming a scene the
   * graph no longer stands in.
   */
  async function reseedSession(prompt: string | undefined, imageSrc: string | undefined, note: string): Promise<boolean> {
    const provider = getWorldProvider(providers)
    const old = sessionRef.current
    reseedAbortRef.current?.abort()
    const controller = new AbortController()
    reseedAbortRef.current = controller
    sessionRef.current = null
    setCaps(null)
    setStatus(note)
    if (old) await old.dispose().catch(() => {})
    if (controller.signal.aborted) return false
    try {
      // Capacity is a wave, not a verdict — a 429 "no available capacity" on a
      // RESEED (the return from a memory) is usually free again within seconds.
      // The boot connect already retries for the same reason; a reseed that
      // dies on the first refusal kicks the player out of the film entirely.
      let fresh: WorldSession | null = null
      for (let attempt = 1; fresh === null; attempt++) {
        try {
          fresh = await provider.connect({
            worldId: actWorldId,
            prompt,
            firstFrameUrl: imageSrc,
            signal: controller.signal,
          })
        } catch (e) {
          const busy = /429|capacity|unavailable|overloaded/i.test(String((e as Error)?.message ?? e))
          if (!busy || attempt >= 4) throw e
          if (controller.signal.aborted) return false
          setStatus(`${note} — the world is busy, trying again (${attempt}/3)…`)
          await new Promise((r) => setTimeout(r, 6000 * attempt))
          if (controller.signal.aborted) return false
        }
      }
      if (!fresh) return false
      if (controller.signal.aborted) {
        void fresh.dispose()
        return false
      }
      sessionRef.current = fresh
      setCaps(fresh.capabilities)
      fresh.onEnded((reason) => { if (!controller.signal.aborted) setStatus(`session ended: ${reason}`) })
      if (mountRef.current) await fresh.mount(mountRef.current)
      // A re-seed mounts a new <video> that defaults to muted; carry the
      // player's standing sound choice across the swap.
      if (soundRef.current) {
        const v = mountRef.current?.querySelector('video')
        if (v) { v.muted = choiceModeRef.current; v.volume = 0.5; void v.play().catch(() => {}) }
      }
      if (!controller.signal.aborted) setStatus('')
      return true
    } catch (e) {
      if (!controller.signal.aborted) setError(playErrorMessage(e))
      return false
    }
  }

  /**
   * A backend can promise frames and then draw nothing, and until now the studio
   * sat in front of that forever with a green "✓ Frames" chip over a black
   * rectangle. Verified against a real Reactor key: the session was created, the
   * transport reported webrtc with one track, the capability row said Frames —
   * and `readyState` stayed 0 with `currentTime` at 0.00 for twenty-five
   * seconds, with nothing on screen to explain it.
   *
   * So watch the mounted surface. If the provider claims streaming and nothing
   * has painted after STALL_AFTER_MS, say so, and name the causes worth checking
   * rather than leaving someone staring at black.
   */
  const STALL_AFTER_MS = 12_000
  useEffect(() => {
    if (!caps?.streaming || status || error) { setStalled(false); return }
    let alive = true
    const started = Date.now()
    const id = window.setInterval(() => {
      if (!alive) return
      const node = mountRef.current
      const v = node?.querySelector('video')
      const c = node?.querySelector('canvas')
      const painting = (v instanceof HTMLVideoElement && v.videoWidth > 0) || (c instanceof HTMLCanvasElement && c.width > 0)
      if (painting) { setStalled(false); window.clearInterval(id); return }
      if (Date.now() - started > STALL_AFTER_MS) setStalled(true)
    }, 1000)
    return () => { alive = false; window.clearInterval(id) }
  }, [caps, status, error])

  /**
   * The detection loop. No-ops immediately whenever no vision provider is
   * configured (see the module-scope comment above), so it costs nothing on the
   * default keyless path.
   *
   * ROUND-ROBIN, one anchor per tick: a frame capture plus a detect call is
   * the expensive part, and asking about every anchor on every tick multiplies
   * that by the number of objects in the scene for no extra responsiveness per
   * chip. Each anchor is tried by its label and then its probe-verified
   * aliases, first hit wins — the same order the authoring probe established
   * them in.
   *
   * The cadence is slower than a self-hosted detector could run: a detector on
   * the same machine sustains a 350ms tick, while this goes over the public
   * Moondream API, where the round trip dominates. A faster tick would only
   * queue calls behind the re-entrancy guard, so it is slower here and honest
   * about why. If chips feel sluggish to lock, the cadence is the first
   * suspect, not the anchor constants — those were tuned at the faster tick.
   */
  useEffect(() => {
    const vision: VisionProvider = getVisionProvider(providers)
    if (!vision.isConfigured()) {
      setTracks({})
      return
    }
    let alive = true
    const controller = new AbortController()
    const PROBE_TICK_MS = 700
    let turn = 0
    const id = window.setInterval(() => {
      if (!alive || pausedRef.current || arcadeDetectingRef.current) return
      const anchored = availableRef.current.filter((b) => b.anchor)
      const node = mountRef.current
      if (!capsRef.current?.streaming || anchored.length === 0 || !node) {
        setTracks({})
        return
      }
      const grab = captureFrameB64(node)
      if (!grab.ok) {
        // Only the READ-BACK failure is worth a notice. "No picture yet" is
        // already explained by the stall watchdog above, in words that name the
        // actual causes.
        if (grab.reason === 'unreadable' && !arcadeWarnedRef.current) {
          arcadeWarnedRef.current = true
          setArcadeNote(
            'Interactive hotspots are off: the live frame could not be read back for detection ' +
              '(a cross-origin surface with no CORS headers taints the canvas). The beat rail below still works.',
          )
        }
        return
      }
      const frame = grab.b64
      const beat = anchored[turn % anchored.length]
      turn += 1
      const anchor = beat?.anchor
      if (!beat || !anchor) return
      arcadeDetectingRef.current = true
      setProbing(true)
      void (async () => {
        let found: DetectedBox | null = null
        for (const label of [anchor.label, ...(anchor.aliases ?? [])]) {
          if (!alive) break
          try {
            const startedAt = performance.now()
            const boxes = await vision.detect(frame, label, controller.signal)
            // Into the episode, hit or miss: "the detector was asked and found
            // nothing" is evidence too, and a record that only kept hits would
            // answer "would this have fired?" with survivorship bias.
            recordDetect(
              label,
              boxes.map((b) => Math.min(b.xMax - b.xMin, b.yMax - b.yMin)),
              Math.round(performance.now() - startedAt),
            )
            const best = pickVisionBox(boxes, anchor.expectedAspect)
            if (best) { found = best; break }
          } catch {
            // A transport hiccup counts as a MISS this tick — which the rules
            // already know how to absorb — never as a player-facing error.
          }
        }
        if (alive) {
          const now = performance.now()
          setTracks((prev) => ({
            ...prev,
            [beat.name]: // Same fallback as the chip layer — the tracker and the renderer must
            // gate on ONE number or a chip can look armed and refuse the click.
            observe(prev[beat.name] ?? emptyTrack(), found, now, anchor.minProximity ?? DEFAULT_PROXIMITY),
          }))
          setProbing(false)
        }
        arcadeDetectingRef.current = false
      })()
    }, PROBE_TICK_MS)
    return () => {
      alive = false
      controller.abort()
      window.clearInterval(id)
    }
    // available/caps are read through refs at TICK time on purpose (see
    // above); listing them here would tear the interval down and rebuild it
    // on every beat-rail render instead of every few seconds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers])

  /**
   * TRIGGER ZONES. An `auto` transition also completes during FREE ROAM: you
   * walk through the door and you have stepped outside, without pressing the
   * event that describes doing it. The evidence is the same evidence, and it is
   * checked on the free signals only (`evidence.autoEligible`) — luminance and
   * motion are arithmetic over a frame already captured, while paying a vision
   * call per tick for every auto event in the world would be a bill nobody
   * asked for.
   *
   * Deliberately quiet about its own failures: a zone that never fires is a
   * WORLD problem the `auto-needs-pixels` lint names at authoring time, not
   * something to interrupt play over.
   */
  useEffect(() => {
    if (paused || sending || !caps?.promptableEvents) return
    let alive = true
    const seen: Record<string, number> = {}
    let prev: Uint8ClampedArray | null = null
    const id = window.setInterval(() => {
      if (!alive || sendingRef.current) return
      const node = mountRef.current
      if (!node) return
      const rgba = readPixels(node)
      if (!rgba) return
      const { luminance, motion, luma } = measureFrame(rgba, prev ?? undefined)
      prev = luma
      // THE EPISODE, written from the tick that was already measuring. This
      // loop used to return early when the state had no trigger zones, which
      // is right for zones and wrong for the record: a session's pixels are
      // worth writing down whether or not anything is watching them THIS
      // instant, because the question an author asks afterwards ("would my
      // gate have fired here?") is asked about states that had no zones at all.
      recordFrame({ lum: luminance, motion })
      const zones = availableRef.current.filter((b) => b.landWhen && autoEligible(b.landWhen))
      if (zones.length === 0) return
      for (const zone of zones) {
        const when = zone.landWhen
        if (!when) continue
        if (!evidenceMet(when, { luminance, motion })) {
          seen[zone.name] = 0
          continue
        }
        const count = (seen[zone.name] ?? 0) + 1
        seen[zone.name] = count
        if (count >= gateBudget(when).hits) {
          seen[zone.name] = 0
          // The zone IS the transition — landing it is the same send the rail
          // would do, so there is exactly one path into a state.
          void send(zone)
          break
        }
      }
    }, 700)
    return () => { alive = false; window.clearInterval(id) }
    // `available` is read through its ref at TICK time, as the probe loop is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, sending, caps, stateId])

  useEffect(() => {
    const id = window.setInterval(() => {
      const rec = recordRef.current
      if (!rec) return
      setEpisodeSize((prev) =>
        prev.frames === rec.frames.length && prev.detects === rec.detects.length
          ? prev
          : { frames: rec.frames.length, detects: rec.detects.length },
      )
    }, 1000)
    return () => window.clearInterval(id)
  }, [])

  /**
   * A BEAT THAT NEEDS NO PRESS. `autoAfterMs` fires an event by itself, that
   * long after the state is entered — paired with `hidden` so the same beat
   * is not also sitting on the rail as a button nobody should have to find.
   *
   * Only ever ONE timer, and it is cancelled by leaving the state, by pausing,
   * or by any other beat going out: a timed beat that fires into the middle of
   * a move the player just made is worse than one that never fires.
   */
  useEffect(() => {
    if (!stateId || sending || paused || !caps?.promptableEvents) return
    const timed = beats.find(
      (b) =>
        b.autoAfterMs !== undefined &&
        b.from.includes(stateId) &&
        !used.has(b.name) &&
        (b.requires ?? []).every((f) => flags.has(f)),
    )
    if (!timed) return
    const id = window.setTimeout(() => { void send(timed) }, timed.autoAfterMs)
    return () => window.clearTimeout(id)
    // `send` is stable enough for this: it reads what it needs off refs and
    // state at call time, and adding it here would restart the timer on every
    // render the player makes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateId, beats, sending, paused, caps, used, flags])

  /**
   * AUTOPILOT — a camera that drives itself while this state is current.
   *
   * An event's drive belongs to a move and is released when it lands; this one
   * belongs to a ROOM and is held until the player leaves it. The two share the
   * transport's single stop, so this deliberately does NOT re-apply on every
   * render: it applies on entering a state, and releases on leaving it, which
   * keeps exactly one owner of the channel at a time.
   *
   * The servo rides the probe loop that already runs for chips (no second
   * detect budget), and fails open: a missed detection leaves the standing
   * drive alone, because a camera that lurches on a dropped frame is worse than
   * one that waits for the next.
   */
  useEffect(() => {
    const s = sessionRef.current
    if (!s || !stateId || !caps?.heldCommands || paused) return
    const auto = scene.states[stateId]?.autopilot
    const tokens = autopilotTokens(auto)
    if (tokens.length === 0) return
    for (const token of tokens) void s.sendEvent({ kind: 'command', value: token }).catch(() => {})
    setMoving(!!auto?.movement)
    setLooking(!!(auto?.lookHorizontal || auto?.lookVertical))
    return () => {
      void s.sendEvent({ kind: 'command', value: DRIVE_RELEASE }).catch(() => {})
      setMoving(false)
      setLooking(false)
    }
  }, [stateId, scene, caps, paused])

  /** The corrective pulse. Separate from the standing drive above so a servo
   *  correction never cancels the drive it is correcting. */
  useEffect(() => {
    const keep = stateId ? scene.states[stateId]?.autopilot?.keepCentered : undefined
    if (!keep || paused) return
    const vision: VisionProvider = getVisionProvider(providers)
    if (!vision.isConfigured()) return
    let alive = true
    const controller = new AbortController()
    const id = window.setInterval(() => {
      const s = sessionRef.current
      const node = mountRef.current
      if (!alive || !s || !node || sendingRef.current) return
      const grab = captureFrameB64(node)
      if (!grab.ok) return
      void (async () => {
        let box: DetectedBox | undefined
        for (const label of [keep.label, ...(keep.aliases ?? [])]) {
          if (!alive) break
          try {
            const started = performance.now()
            const boxes = await vision.detect(grab.b64, label, controller.signal)
            recordDetect(label, boxes.map((b) => Math.min(b.xMax - b.xMin, b.yMax - b.yMin)), Math.round(performance.now() - started))
            box = pickVisionBox(boxes)
            if (box) break
          } catch {
            // Fail open — see the effect above.
          }
        }
        if (!alive) return
        const look = centeringLook(box ?? null)
        if (!look) return
        void s.sendEvent({ kind: 'command', value: look }).catch(() => {})
        // A PULSE, not a hold: the standing drive owns the channel, and a
        // correction that stayed applied would become the drive.
        window.setTimeout(() => {
          const still = sessionRef.current
          if (alive && still) void still.sendEvent({ kind: 'command', value: DRIVE_RELEASE }).catch(() => {})
        }, SERVO_PULSE_MS)
      })()
    }, SERVO_TICK_MS)
    return () => { alive = false; controller.abort(); window.clearInterval(id) }
  }, [stateId, scene, paused, providers])

  useEffect(() => {
    if (!bookend) return
    const id = window.setTimeout(() => {
      if (bookend.kind === 'intro') endIntro()
      else setBookend(null)
    }, CUTSCENE_TIMEOUT_MS)
    return () => window.clearTimeout(id)
    // `endIntro` reads refs and current state at call time; adding it here
    // would restart the cap on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookend])

  /** Coming out from under the intro: a clip that ended mid-stride wants the
   *  world already moving, one that ended still wants it standing. */
  function endIntro(): void {
    const world = worldRef.current
    setBookend(null)
    bookendDoneRef.current = null
    if (!world?.introVideo) return
    const boot = bootAfterIntro(world.introStatic)
    setMoving(boot.moving)
    if (boot.driveToken && sessionRef.current && caps?.heldCommands) {
      void sessionRef.current.sendEvent({ kind: 'command', value: boot.driveToken }).catch(() => {})
      // A boot drive is a continuation, not a control the player asked for, so
      // it lets go on its own.
      window.setTimeout(() => {
        void sessionRef.current?.sendEvent({ kind: 'command', value: DRIVE_RELEASE }).catch(() => {})
        setMoving(false)
      }, INTRO_DRIVE_MS)
    }
  }

  /**
   * THE OUTRO — earned, and played once. It is a CONDITION (a flag held in a
   * state), not a destination, so it is watched rather than fired: the beat
   * that grants the flag does not know it completed the world.
   */
  useEffect(() => {
    const world = worldRef.current
    if (!world?.outro || bookend) return
    if (!outroDue(world.outro, stateId, flags, outroPlayedRef.current)) return
    outroPlayedRef.current = true
    setBookend({ kind: 'outro', video: world.outro.video })
  }, [stateId, flags, bookend])

  /**
   * THE ODOMETER — driving somewhere in a world with no geometry.
   *
   * Nothing here can be asked where the destination is. What IS known is that
   * the player is holding forward, so the distance is integrated from that
   * (`play/drive.ts`), the HUD counts it down, and at zero the event plays
   * itself — its first phase being the place coming into view.
   *
   * The tick is deliberately coarse (250ms): this is a display distance in a
   * world without metres, and a smoother number would only imply a precision
   * that does not exist.
   */
  useEffect(() => {
    const legal = beats.filter((b) => b.waypoint && stateId && b.from.includes(stateId))
    if (legal.length === 0) return
    // Fresh distances on entering the state: a mission you left and came back
    // to starts its drive again, rather than resuming a journey the picture has
    // no memory of.
    setOdometer(Object.fromEntries(legal.map((b) => [b.name, b.waypoint?.distanceM ?? 0])))
    let last = performance.now()
    const id = window.setInterval(() => {
      const now = performance.now()
      const dt = now - last
      last = now
      if (pausedRef.current || sendingRef.current) return
      setOdometer((prev) => {
        const next: Record<string, number> = {}
        for (const b of legal) {
          const spec = b.waypoint
          if (!spec) continue
          next[b.name] = tickOdometer(prev[b.name] ?? spec.distanceM, dt, forwardRef.current, spec.speedMs)
        }
        return next
      })
    }, 250)
    return () => window.clearInterval(id)
  }, [beats, stateId])

  /** Arriving. Kept out of the tick above so the fire happens once, on the
   *  render that sees zero, rather than inside a timer that may still be
   *  mid-flight when the beat starts sending. */
  useEffect(() => {
    if (sending || paused) return
    const arrived = beats.find(
      (b) => b.waypoint && stateId && b.from.includes(stateId) && (odometer[b.name] ?? Infinity) <= 0,
    )
    if (arrived) void send(arrived)
  }, [odometer, beats, stateId, sending, paused])

  /**
   * THE CAMPAIGN HAND-OFF, on every state ENTRY — boot included, which is the
   * whole reason it lives in an effect rather than inside `send`: a chapter
   * can be left by a beat, by a jump, or by something the director authored,
   * and all three are the same event to a campaign.
   *
   * Boot being included is exactly what makes `handoffFor`'s entrance guard
   * load-bearing: a spine that hangs an edge on the entrance would otherwise
   * bounce the player out of the chapter before they had played a second of it.
   */
  useEffect(() => {
    if (!campaign || !actId || !stateId) return
    const hop = handoffFor({
      graph: campaign.graph,
      actId,
      stateId,
      entranceState: entranceRef.current ?? undefined,
      flags: [...flags],
    })
    if (!hop) return
    // A DEAD END is authored, not broken: the act said this state ends the run.
    // Say so and leave the rewind affordance in reach — never strand the
    // player. Before this the branch fell through `if (!hop)` and they simply
    // stood there with no idea the story had stopped.
    if (hop.kind === 'dead-end') {
      setDeadEnd(hop.edge.label ?? 'This is where this road ends.')
      return
    }
    setDeadEnd(null)
    const next = campaign.graph.acts.find((a) => a.actId === hop.toActId)
    if (!next) return
    setHandoffNote(`${next.title} — carrying ${hop.flags.length ? hop.flags.join(', ') : 'nothing'}`)
    setFlags(new Set(hop.flags))
    setUsed(new Set())
    setTrail([])
    setActId(hop.toActId)
    setActWorldId(next.worldId)
  }, [campaign, actId, stateId, flags])

  /**
   * AMBIENT TRANSIENTS. The world's small moving things, finally reaching it.
   *
   * Every authored state carries two or three of these and nothing read them
   * until now — the kernel writes them into every world it makes and they
   * were inert in all of them. One line rides the state prompt
   * for `AMBIENT.holdMs`, then the plain state prompt is sent again to take it
   * back off, and the next is scheduled 8-20s out.
   *
   * NEVER while a beat is in flight: an ambient re-send would land in the
   * middle of a transition the player is watching and fight it for the picture.
   * `sending` and `progressNote` are that signal, so the effect re-runs when
   * either changes and simply reschedules if the moment is wrong.
   */
  useEffect(() => {
    const pool = stateId ? scene.states[stateId]?.ambient : undefined
    if (!stateId || !pool?.length || error) return
    const base = scene.states[stateId]?.base ?? ''
    let cancelled = false
    let holdTimer: number | undefined
    let waitTimer: number | undefined

    const schedule = (): void => {
      waitTimer = window.setTimeout(() => {
        if (cancelled) return
        // A beat is playing — skip this slot rather than talk over it.
        // The session is read HERE, not when the effect ran. Captured at setup
        // it was almost always null — this effect fires on `stateId`, which is
        // set before `connect()` resolves — so the mechanic returned early and
        // never retried. 70s on the protocol wire showed the boot state frame
        // and nothing after it, which is what sent me looking.
        const s = sessionRef.current
        if (!s) { schedule(); return }
        if (sendingRef.current !== null || progressRef.current !== null) { schedule(); return }
        const pick = nextAmbient(pool, ambientLastRef.current, Math.random())
        if (!pick) return
        ambientLastRef.current = pick.index
        void s.sendEvent({ kind: 'state', value: promptWithAmbient(base, pick.line), stateId }).catch(() => {})
        holdTimer = window.setTimeout(() => {
          if (cancelled) return
          void s.sendEvent({ kind: 'state', value: promptWithAmbient(base, null), stateId }).catch(() => {})
          schedule()
        }, AMBIENT.holdMs)
      }, ambientWait(Math.random()))
    }
    schedule()
    return () => {
      cancelled = true
      if (waitTimer) window.clearTimeout(waitTimer)
      if (holdTimer) window.clearTimeout(holdTimer)
    }
  }, [stateId, scene, error])

  /**
   * REWIND bookkeeping. A choice point is a state you left by two or more legal
   * doors, so going back to it means something: the other door is still there.
   * Kept as a stack, updated on every state change by an effect over the same
   * three inputs the doors are computed from.
   */
  useEffect(() => {
    if (!stateId) return
    const points = choicePointsRef.current
    if (isChoicePoint({ states: scene.states, events: scene.events }, stateId, flags) && points[points.length - 1] !== stateId) {
      points.push(stateId)
      if (points.length > 40) points.shift()
    }
    setRewindTarget(rewindTargetFor(points, stateId))
  }, [stateId, scene, flags])

  // A stale chip pointing at the PREVIOUS state's object is worse than none —
  // clear on transition rather than waiting for the next tick to notice the
  // anchored beat set changed. This also drops ACQUISITION: a new scene
  // re-gates every anchor, so you walk up to it again rather than inheriting
  // a lock from a room you already left.
  useEffect(() => {
    setTracks({})
  }, [stateId])

  /** The state the run is standing in, when standing in one ends it. */
  const ending = stateId ? scene.states[stateId]?.ending : undefined

  /** Back to the entrance with an EMPTY ledger — a run you replay carrying the
   *  last one's flags is not a replay. */
  async function restart() {
    const entrance = trail[0]
    const st = entrance ? scene.states[entrance] : undefined
    if (!entrance || !st) return
    setFlags(new Set())
    setUsed(new Set())
    setTrail([entrance])
    await send({ name: entrance, label: entrance, kind: 'state', text: st.base, stateId: entrance, from: [] })
  }

  /** Only the beats the machine can legally take from where it is standing. */
  progressRef.current = progressNote
  const available = legalBeats(beats, stateId, flags, used)
  // Read by the arcade tick above, which runs on its own interval outside
  // React's render cycle — a tick that fires between renders still needs to
  // see where the machine actually is.
  availableRef.current = available
  capsRef.current = caps

  /** One reading of the picture, with motion measured against the last one. */
  const lumaRef = useRef<Uint8ClampedArray | null>(null)
  function sampleFrame(): FrameSample | null {
    const node = mountRef.current
    if (!node) return null
    const rgba = readPixels(node)
    if (!rgba) return null
    const { luminance, motion, luma } = measureFrame(rgba, lumaRef.current ?? undefined)
    lumaRef.current = luma
    // RECORD it. Every pixel sample this player already takes is an episode
    // frame; writing it down costs three numbers and is what lets an authored
    // gate be replayed over the session afterwards instead of guessed at.
    recordFrame({ lum: luminance, motion })
    return { luminance, motion }
  }

  /** Append to the episode, bounded. A session left open all afternoon must not
   *  grow without limit, and the OLDEST samples are the ones worth dropping —
   *  a gate is asked about what happened recently. */
  function recordFrame(f: { lum: number; motion: number | null }) {
    const rec = recordRef.current
    if (!rec) return
    rec.frames.push({ tMs: Math.round(performance.now() - t0Ref.current), ...f })
    if (rec.frames.length > EPISODE_CAP) rec.frames.splice(0, rec.frames.length - EPISODE_CAP)
  }

  function recordDetect(label: string, extents: number[], ms?: number) {
    const rec = recordRef.current
    if (!rec) return
    rec.detects.push({ tMs: Math.round(performance.now() - t0Ref.current), label, extents, ...(ms === undefined ? {} : { ms }) })
    if (rec.detects.length > EPISODE_CAP) rec.detects.splice(0, rec.detects.length - EPISODE_CAP)
  }

  function recordMark(name: string) {
    const rec = recordRef.current
    if (!rec) return
    rec.marks.push({ tMs: Math.round(performance.now() - t0Ref.current), name })
    if (rec.marks.length > EPISODE_CAP) rec.marks.splice(0, rec.marks.length - EPISODE_CAP)
  }

  /**
   * Hold here until the picture SHOWS the arrival — or until the fail-open
   * ceiling, which lands anyway. Landing a destination prompt while the pixels
   * still show the source is what makes a world model resolve backward, and a
   * timer cannot tell the difference; this is the difference.
   *
   * Free signals first (they are arithmetic over pixels already captured), a
   * vision call only when a label is the evidence and nothing free settled it.
   */
  async function awaitArrival(when: SMLandWhen, note: string): Promise<'evidence' | 'timeout' | 'blind'> {
    // The instant the LIVE gate starts counting, written into the record so the
    // inspector's replay can count from the same place.
    //
    // Measured on a live Reactor session: the replay said the gate fired at
    // 7.8s while the live gate had not begun watching yet — it was still
    // streaming the event's two phases. Both were right about WHETHER the gate
    // is satisfiable in this world and neither was talking about the same
    // clock, which is a difference an author reading "✓ 7.8s" cannot be
    // expected to infer.
    recordMark(`gate:${note}`)
    const { hits, timeoutMs } = gateBudget(when)
    const vision = getVisionProvider(providers)
    const started = Date.now()
    let seen = 0
    lumaRef.current = null // motion is measured within THIS gate, not across it
    while (Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, 700))
      if (!sessionRef.current) return 'blind'
      const sample = sampleFrame()
      if (!sample) return 'blind' // nothing readable — never trap the player
      let full: FrameSample = sample
      const node = mountRef.current
      if (when.label && node && !evidenceMet(when, sample) && vision.isConfigured()) {
        const grab = captureFrameB64(node)
        if (grab.ok) {
          for (const label of [when.label, ...(when.aliases ?? [])]) {
            try {
              const boxes = await vision.detect(grab.b64, label)
              const best = pickVisionBox(boxes)
              if (best) {
                full = { ...sample, labelExtent: Math.min(best.xMax - best.xMin, best.yMax - best.yMin) }
                break
              }
            } catch { /* a miss this tick */ }
          }
        }
      }
      if (evidenceMet(when, full)) {
        seen += 1
        setProgressNote(`${note} · evidence ${seen}/${hits}`)
        if (seen >= hits) return 'evidence'
      }
    }
    return 'timeout'
  }

  /** Push one authored beat into the live world, and move the machine with it. */
  /** Returns how the beat's arrival gate resolved, when it had one — the
   *  set-piece walk needs to tell an author that a `settle` did not settle, and
   *  this function is the only place that knows. */
  /** One fresh homecoming line in the world's cast voice — written by the
   *  configured LLM from what the player has actually seen. Falls back to the
   *  authored line on any failure, so the voice never goes missing. */
  async function improvReturnLine(memory: string, seen: string[], unseen: string[], fallback: string): Promise<string> {
    try {
      const llm = getLLMProvider(providers)
      if (!llm.isConfigured()) return fallback
      const cast = (worldRef.current?.['voicePart'] as { instructions?: string } | undefined)?.instructions
        ?? 'A warm, wry woman in her fifties, the day after her mother\'s funeral.'
      const out = await llm.complete({
        temperature: 0.9,
        maxTokens: 80,
        messages: [
          { role: 'system', content: `${cast} Write ONE line she says aloud. Only the line itself — no quotes, no stage directions, 22 words or fewer. Grief under the words, not in them; she laughs mid-line if it wants one.` },
          { role: 'user', content: `Back at the living-room table after showing the family the photograph "${memory}". Photographs already seen: ${seen.join('; ') || 'none'}. Still waiting in the box or on the wall: ${unseen.join('; ') || 'nothing — this was the last one'}. The line as they settle back down:` },
        ],
      })
      const line = out.trim().replace(/^["'\u201c]+|["'\u201d]+$/g, '').replace(/\s+/g, ' ')
      return line.length > 4 && line.length < 220 ? line : fallback
    } catch {
      return fallback
    }
  }

  async function send(beat: Beat): Promise<'evidence' | 'timeout' | 'blind' | null> {
    const s = sessionRef.current
    if (!s || sending) return null
    // A choice film starts silent only until its first press: that press is the
    // user gesture every browser demands before audio, so it turns the bed and
    // the voice-overs on — no 🔊 hunt before the first line is heard.
    if (choiceModeRef.current && !soundRef.current) toggleSound()
    // A CONSOLE opens instead of streaming. It behaves like an override — the
    // world keeps breathing behind it, nothing lands, there is no `to`.
    if (beat.terminal) {
      setTerminal({ beat: beat.name, spec: beat.terminal })
      setTermLog(beat.terminal.greeting ? [{ who: 'it', text: beat.terminal.greeting }] : [])
      // The room greets you ALOUD when its console opens — the first thing the
      // player hears from the suite, before they have typed anything.
      if (beat.terminal.greeting && soundRef.current) {
        duckMusic(true)
        void speak(beat.terminal.greeting, providers).finally(() => { if (!playingCutRef.current) duckMusic(false) })
      }
      return null
    }
    setSending(beat.name)
    setSendError(null)
    let gateVerdict: 'evidence' | 'timeout' | 'blind' | null = null
    if (beat.narration) {
      // IMPROVISED HOMECOMINGS. The same authored return line every time reads
      // as a machine; a film's world writes the line fresh each time, from
      // what the player has actually seen and what is still in the box. The
      // authored line is the fallback, so a missing or failing LLM costs
      // variety, never the voice.
      const improv = choiceModeRef.current
        && worldRef.current?.['improviseReturns'] === true
        && beat.name.startsWith('put_back_')
      if (improv) {
        const memory = beat.name.slice('put_back_'.length)
        const pickups = beats.filter((b) => b.name.startsWith('pickup_'))
        const held = (b: Beat) => (b.grants ?? []).every((f) => flags.has(f))
        const seen = pickups.filter(held).map((b) => b.label)
        const unseen = pickups.filter((b) => !held(b)).map((b) => b.label)
        const label = pickups.find((b) => b.name === `pickup_${memory}`)?.label ?? 'the photograph'
        setNarration(await improvReturnLine(label, seen, unseen, beat.narration))
      } else {
        setNarration(beat.narration)
      }
    }

    // THE CONTROLS THIS MOVE PRESSES. The model listens on two channels and
    // they have to agree: prose about striding forward over an idle movement
    // channel is a contradiction the picture resolves badly. Held for the whole
    // beat unless the author asked for a pulse.
    let releaseDrive: (() => void) | null = null
    if (hasDrive(beat.drive)) {
      for (const token of driveTokens(beat.drive)) {
        void s.sendEvent({ kind: 'command', value: token }).catch(() => {})
      }
      setMoving(!!beat.drive?.movement)
      setLooking(!!(beat.drive?.lookHorizontal || beat.drive?.lookVertical))
      let released = false
      releaseDrive = () => {
        if (released) return
        released = true
        void s.sendEvent({ kind: 'command', value: DRIVE_RELEASE }).catch(() => {})
        setMoving(false)
        setLooking(false)
      }
      if (beat.drivePulseMs !== undefined) {
        const pulse = beat.drivePulseMs
        window.setTimeout(() => releaseDrive?.(), pulse)
      }
    }
    try {
      // CHOREOGRAPHY. A move that takes several beats is streamed one beat at a
      // time: a single prompt describing the whole thing lands the ending while
      // the pixels still show the beginning, which is the rollback phases exist
      // to prevent. Each phase carries its own camera for the same reason.
      const phases = beat.phases ?? []
      for (const [i, phase] of phases.entries()) {
        setProgressNote(`${beat.name} · beat ${i + 1}/${phases.length}`)
        const text = [phase.base, phase.camera, phase.movement, phase.detail].filter(Boolean).join(' ')
        await s.sendEvent({ kind: 'prompt', value: text })
        await new Promise((r) => setTimeout(r, Math.max(1000, phase.minMs ?? 5000)))
      }

      // THE SEAM. A transition's `to` resolves against CUTSCENE ids before state
      // ids, so an authored clip plays before the destination lands. Fail-open
      // is the rule that matters: a clip that 404s, stalls, or was never made
      // must not become a wall in a world still being built.
      const dest = beat.kind === 'state' ? resolveDestination(beat.stateId, cutscenes, flags) : null
      if (dest?.kind === 'cutscene') {
        setPlayingCut(dest.cutscene)
        // A film does not caption its own projection — the loading note is an
        // authoring surface; story mode shows nothing while the clip rolls.
        if (!choiceModeRef.current) setProgressNote(`${beat.name} · playing ${dest.cutscene.label ?? dest.cutscene.id}`)
        await new Promise<void>((resolve) => {
          const done = () => { window.clearTimeout(timer); resolve() }
          const timer = window.setTimeout(done, CUTSCENE_TIMEOUT_MS)
          cutDoneRef.current = done
        })
        cutDoneRef.current = null
        setPlayingCut(null)
        // Land where the CUT says, which is the destination the author wired
        // behind it — the transition's own `to` was the cut's id.
        beat = { ...beat, stateId: dest.state }
      }

      // THE FLOOR. `landWhen` answers "are we there yet" with evidence when
      // there is evidence to be had; `minPlayMs` is what an author has when
      // there is not — a minimum time the move streams before the destination
      // is allowed to land, which is the difference between a move and a cut.
      if (beat.minPlayMs && beat.kind === 'state') {
        const held = beat.minPlayMs
        setProgressNote(`${beat.name} · playing (${Math.round(held / 1000)}s)`)
        await new Promise((r) => setTimeout(r, held))
      }

      // ARRIVAL. Watch the picture become the destination before landing it.
      //
      // The gate can come from either end. An event carries its own `landWhen`
      // when the crossing needs particular evidence; otherwise the DESTINATION
      // may name what proves you got there (`arriveLabel`), which is how a world
      // gates a room once instead of on every door into it. The event wins when
      // both exist — it is the more specific statement.
      //
      // A landWhen with `auto: true` is excluded on purpose: that is a
      // TRIGGER-ZONE spec — "fire me when the player is moving" — and using it
      // as the arrival gate makes a deliberately PRESSED move wait for walking
      // evidence it may never see (measured: the mock's slow canvas never
      // reaches it, and the beat hung 20s at its timeout).
      const arriveLabel = beat.stateId ? scene.states[beat.stateId]?.arriveLabel : undefined
      const zoneSpec = beat.landWhen?.auto === true
      const gate: SMLandWhen | undefined =
        (beat.landWhen && !zoneSpec) ? beat.landWhen
        : (arriveLabel && !zoneSpec) ? { label: arriveLabel, hits: 1 }
        : undefined
      if (gate && beat.kind === 'state') {
        setProgressNote(`${beat.name} · waiting for arrival`)
        gateVerdict = await awaitArrival(gate, beat.name)
        const verdict = gateVerdict
        // Say WHY it landed. A gate that quietly gives up is a gate that
        // taught the player nothing about their own world.
        setLandNote(
          verdict === 'timeout'
            ? `"${beat.name}" landed unverified — ${describeGate(gate)}.`
            : verdict === 'blind'
              ? `"${beat.name}" landed unverified — the live frame could not be read for evidence.`
              : null,
        )
      }

      setProgressNote(null)
      // The event's OWN framing rides with its prose; its NARRATION does not.
      // `promptForBeat` owns that distinction so it can be tested as a value —
      // see the comment there on why an e2e cannot carry this claim.
      //
      // A destination carrying its own seedFrame does not land as a prompt
      // swap. Steering is soft, and a backend that took an image at start
      // ignores a new one mid-run, so the only honest way to BE in that scene
      // is a fresh session booted from the picture — see reseedSession.
      const seedSrc = beat.kind === 'state' && beat.stateId ? stateSeedSrc(scene.states[beat.stateId]) : undefined
      // LANDING WHERE YOU ALREADY STAND: a beat that returns to its own state
      // (a memory that ends back on the couch) must not tear the live room
      // down and re-boot it — the session is already that scene, so the seed
      // is redundant and keeping it is the difference between instant and a
      // twenty-second wait after every photograph.
      if (seedSrc && beat.stateId !== stateId) {
        // THE ZOOM DOOR: picking up a photograph holds the print up over a
        // black screen while its world boots behind it — one continuous zoom
        // into the picture, then the print fades and the player is inside it.
        // The clip-per-door design is dead: a clip rendered its own version of
        // the scene, so the zoom ended on one image and a lookalike session
        // started on another. The session's seed and the zoomed print are now
        // the same photograph.
        if (choiceModeRef.current) {
          const photo = (worldRef.current?.['photoCards'] as Record<string, string> | undefined)?.[beat.name]
          if (photo) {
            doorIdRef.current += 1
            setDoorDone(false)
            setDoor({ src: photo, id: doorIdRef.current })
          }
        }
        const doorPhoto = choiceModeRef.current
          && !!(worldRef.current?.['photoCards'] as Record<string, string> | undefined)?.[beat.name]
        const landed = await reseedSession(promptForBeat(beat), seedSrc,
          doorPhoto ? 'the photograph comes alive…' : choiceModeRef.current ? 'cutting to the next scene…' : `${beat.label} — the suite is remembering…`)
        if (!landed) { setDoor(null); setSendError('The scene would not open — the replay failed to start.') }
      } else if (beat.stateId !== stateId) {
        await s.sendEvent({ kind: beat.kind, value: promptForBeat(beat), stateId: beat.stateId })
      }
      recordMark(`beat:${beat.name}`)
      // Advance only after the provider took it, so a rejected transition does
      // not leave the rail offering moves from a state we never entered.
      if (beat.grants?.length) setFlags((prev) => new Set([...prev, ...(beat.grants ?? [])]))
      if (beat.oneShot) setUsed((prev) => new Set([...prev, beat.name]))
      if (beat.kind === 'state' && beat.stateId) {
        setStateId(beat.stateId)
        recordMark(`state:${beat.stateId}`)
        // The destination's own line takes over from the beat's outcome line —
        // unless the destination has nothing to say, in which case what the
        // player just read stays rather than blinking out.
        // No world document, no derivation: an assertion here would be a cast
        // standing in for a check, and the honest answer to "what does the
        // player read" when the world has not loaded is nothing.
        const loaded = worldRef.current
        const arrived = loaded ? narrationFor(loaded, scene.states[beat.stateId]) : undefined
        // A beat that carries its own line WINS over the destination's — the
        // put-it-back events are authored as homecoming lines, and letting the
        // state's narration clobber them made every return replay the opening.
        if (arrived && !beat.narration) setNarration(arrived)

        // The trail is where you have BEEN, not where the graph could go — the
        // inspector's timeline reads it, and jumping back re-enters a state.
        setTrail((t) => [...t, beat.stateId as string])
      }
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'The backend rejected that event.')
    } finally {
      // ALWAYS, including on the error path: a held `forward` that nothing
      // clears keeps walking after the move that asked for it has gone.
      releaseDrive?.()
      setProgressNote(null)
      setSending(null)
    }
    return gateVerdict
  }

  /**
   * ASK THE CONSOLE. Runs on the author's own model, with a system prompt built
   * from the persona and only the facts the player's flags unlock — a fact the
   * model was never told is a fact it cannot leak.
   *
   * A console with a `witness` ledger is more than a Q&A: it classifies the
   * question, and when the detective asks to SEE a memory it replays one —
   * on a fresh session seeded from a picture painted for that very answer,
   * which is what makes a leading question visible (see ./witness.ts).
   */
  async function askTerminal(): Promise<void> {
    const spec = terminal?.spec
    const question = termInput.trim()
    if (!spec || !question || termBusy) return
    const llm = getLLMProvider(providers)
    setTermInput('')
    setTermLog((l) => [...l, { who: 'you', text: question }])
    if (!llm.isConfigured()) {
      setTermLog((l) => [...l, { who: 'it', text: 'NO LINK — this console answers on YOUR language model. Configure one in Settings.' }])
      return
    }
    const witness = witnessOf(spec)
    setTermBusy(true)
    try {
      const answer = await llm.complete({
        temperature: witness ? 0.7 : 0.6,
        maxTokens: witness ? 700 : 400,
        json: !!witness,
        messages: [
          { role: 'system', content: witness ? witnessSystem(spec, witness) : terminalSystem(spec, flags) },
          { role: 'user', content: question },
        ],
      })
      const parsed = witness ? parseWitnessAnswer(answer) : undefined
      const line = parsed ? parsed.reply : (answer.trim() || '…')
      setTermLog((l) => [...l, { who: 'it', text: line }])
      // A clip that is about to replay carries its own recorded voice-over and
      // caption; speaking the reply aloud first would say the same memory
      // twice, back to back. Only the clip-less replies get the live voice.
      const pack = spec ? witnessClipPackOf(spec) : undefined
      const clip = parsed && parsed.tag === 'neutral'
        ? pack?.[`${memoryIdOf(spec, parsed) ?? ''}_neutral`] : undefined
      if (parsed && clip) {
        await replayWitnessMemory(parsed, line)
      } else {
        if (soundRef.current) {
          duckMusic(true)
          void speak(line, providers).finally(() => { if (!playingCutRef.current) duckMusic(false) })
        }
        if (parsed && parsed.tag !== 'other' && parsed.replayBase) await replayWitnessMemory(parsed)
      }
    } catch (e) {
      setTermLog((l) => [...l, { who: 'it', text: `FAULT — ${e instanceof Error ? e.message : 'no answer'}` }])
    } finally {
      setTermBusy(false)
    }
  }

  /**
   * THE SUITE REPLAYS. Two honest shapes, one rule each:
   *
   *  · A NEUTRAL ask with a pre-baked clip plays the recording — the honest
   *    memory, instant, exactly as the suite recorded it. The live session is
   *    disposed for the length of the clip: nothing bills while a recording
   *    plays. The clip ends by itself and the suite settles back.
   *
   *  · Everything else re-renders LIVE: the reply is already on screen, this
   *    paints the seed the answer described and boots a FRESH session on it.
   *    The image is the whole trick — a world model holds its seed far harder
   *    than its prompt, so a contaminated memory painted into the seed is a
   *    contaminated memory the player WATCHES, not one they are told about.
   *    A leading question has no clip to hide behind; the wait is visible,
   *    and that is the point.
   *
   * Fail-open at each step: a missing image model or a refused painting costs
   * a log line, never the console.
   */
  async function replayWitnessMemory(answer: WitnessAnswer, caption?: string): Promise<void> {
    const spec = terminal?.spec
    const pack = spec ? witnessClipPackOf(spec) : undefined
    const clip = spec ? pack?.[`${memoryIdOf(spec, answer) ?? ''}_neutral`] : undefined
    if (answer.tag === 'neutral' && clip) {
      setTermLog((l) => [...l, { who: 'it', text: '(the suite replays what it remembers…)' }])
      const old = sessionRef.current
      sessionRef.current = null
      await old?.dispose().catch(() => {})
      setReplaying(true)
      cutDoneRef.current = () => { cutDoneRef.current = null; setPlayingCut(null); void returnFromReplay() }
      setPlayingCut({ id: 'witness_replay', label: 'the suite remembers', video: clip, from: stateId ?? '', to: stateId ?? '', subtitle: caption })
      return
    }
    const image = getImageProvider(providers)
    if (!image.isConfigured()) {
      setTermLog((l) => [...l, { who: 'it', text: '(the memory will not focus — no image model is configured to paint it)' }])
      return
    }
    setTermLog((l) => [...l, { who: 'it', text: '(the suite replays what it remembers…)' }])
    let seedSrc: string | undefined
    try {
      const { b64, mime } = await image.generate(answer.replaySeedPrompt || answer.replayBase || '')
      seedSrc = `data:${mime};base64,${b64}`
    } catch {
      setTermLog((l) => [...l, { who: 'it', text: '(the memory is too faint to show)' }])
      return
    }
    const landed = await reseedSession(answer.replayBase, seedSrc, 'the suite is remembering…')
    if (landed) setReplaying(true)
    else setTermLog((l) => [...l, { who: 'it', text: '(the replay would not start)' }])
  }

  /** Back out of a replay: the machine never left its state, so this re-seeds
   *  the state it stands in — its own prompt, its own seed. The rail is wrong
   *  for this by design: a replay is not a state, and offering the room's
   *  events from inside a memory would move the graph under a picture the
   *  graph cannot account for. Also the manual exit from a replay CLIP, which
   *  is why the clip and its done-handler are cleared here, not only in the
   *  clip's own on-ended. */
  async function returnFromReplay(): Promise<void> {
    setReplaying(false)
    cutDoneRef.current = null
    setPlayingCut(null)
    const id = stateId
    const st = id ? scene.states[id] : undefined
    if (!st) return
    await reseedSession(statePrompt(st), stateSeedSrc(st), 'the suite settles…')
  }

  /**
   * THE DIRECTOR — you type what happens next, and the world becomes it.
   *
   * There is no server here: the brief is built from what the AUTHOR wrote
   * (`./director.ts`) and goes straight to the same kernel the editor's
   * composer uses — your model, your key, one round trip.
   *
   * The load-bearing part is the last three lines. The kernel authors an event
   * but only unreliably asks for it to be played, so we read the shape it
   * wrote, rebuild the rail (a beat list computed at connect time would leave
   * the new event unpressable), and FIRE it ourselves through the same `send`
   * a rail button uses. A director whose work you have to go and find in the
   * graph editor is not a director.
   */
  async function direct(text: string): Promise<string> {
    const llm = getLLMProvider(providers)
    if (!llm.isConfigured()) return 'the director authors with YOUR model — configure one in Settings first'
    if (!stateId) return 'the world has not opened yet'
    if (sending) return 'something is already playing — wait for it to land'

    const doc = await store.getWorld(actWorldId)
    const world = unwrapWorldDoc(doc)
    const out = await directAction({
      text,
      ctx: contextFrom(world, { states: scene.states, events: scene.events }, stateId, flags),
      readScene: async () => {
        const sc = await store.getScene(actWorldId)
        return { states: sc.states, events: sc.events || [] }
      },
      kernel: async (instruction) => {
        // Graph-scale budget: a director brief authors a state plus its two
        // reactions, all at full density, and reasoning tokens come out of the
        // same allowance. The editor's default is sized for one field.
        const r = await runLocalEdit({ llm, store, tools, worldId: actWorldId, instruction, maxTokens: 16000 })
        return { reply: r.reply, applied: r.applied, asked: r.asked ?? [] }
      },
      // A silent gap while it tries again reads as a director that has stopped.
      onRound: (round, why) => setDirectNote(`the kernel's answer was rejected (${why}) — asking again, ${round + 1}…`),
    })

    // Whatever it wrote, the LIVE surfaces have to show it — the rail, the
    // inspector's graph, and the chips all read this scene.
    const fresh = await store.getScene(actWorldId)
    const rail = beatsFrom(fresh, cutscenes)
    setScene({ states: fresh.states, events: fresh.events || [] })
    setBeats(rail)
    setRev(fresh.rev ?? '')
    if (!out.ok) {
      setDirectNote(null)
      return out.say
    }

    // PERFORM THE BATCH, not its first beat. `directAction` returns a full
    // `safeDirectives` list — a goto to move the player, a fire to play an
    // authored event, a playSequence for a set-piece — and this took
    // `play[0]?.fire`, so every goto, every sequence, and everything after the
    // first was dropped. The dead `batchHoldMs` constant was the tell. Each
    // directive's own `afterMs` is honoured between them, which is what makes
    // a batch read as a sequence of events rather than one simultaneous jump.
    for (const d of out.play) {
      if (d.afterMs) await new Promise((r) => setTimeout(r, d.afterMs))
      if (d.goto) { setStateId(d.goto); continue }
      if (d.playSequence) {
        const q = sequences.find((x) => x.id === d.playSequence)
        if (q) await runSequence(q)
        continue
      }
      if (!d.fire) continue
      const b = rail.find((x) => x.name === d.fire)
      if (!b) continue
      setDirectNote(`▸ ${b.label}`)
      await send(b)
    }

    const fire = out.play[0]?.fire
    const beat = fire ? rail.find((b) => b.name === fire) : undefined
    if (!beat) {
      // Authored, but nothing safe to play from here. The director never
      // auto-lands an ending, so this is a legitimate outcome and not an
      // error — the new structure is on the rail either way.
      setDirectNote(`staged ${out.authored.length} event${out.authored.length === 1 ? '' : 's'} — press one when you are ready`)
      return `${out.say} — staged ${out.authored.join(', ')}`
    }
    // REMEMBER IT. The next typed action is answered with this in the brief, so
    // the director stops treating each one as the first thing to happen here.
    // Best-effort: a lost beat costs continuity, and failing the action the
    // player just watched land would cost more.
    await tools
      .run('author.ops', {
        world: actWorldId,
        ops: [{ op: 'add_story_beat', summary: `${text.trim()} — ${out.say}`, states: beat.stateId ? [beat.stateId] : [] }],
      }, { origin: 'app' })
      .catch(() => {})
    return `${out.say} — playing ${beat.label}`
  }

  /**
   * WALK A SET-PIECE. Each beat enters its state and then waits the way the
   * author asked: until the picture settles, until the player does something,
   * or for a stated time.
   *
   * `settle` reuses the arrival gate a transition uses, so a cinematic beat and
   * a verified crossing wait on the same evidence rather than on two different
   * ideas of "landed".
   */
  async function runSequence(sequence: SMSequence): Promise<void> {
    const s = sessionRef.current
    if (!s || sending || playingSeq) return
    let plan: PlannedBeat[]
    try {
      plan = sequencePlan(sequence, scene.states)
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'That set-piece cannot be played.')
      return
    }
    for (const [i, beat] of plan.entries()) {
      setPlayingSeq({ title: sequence.title, at: i + 1, of: plan.length })
      const st = scene.states[beat.state]
      if (!st) break
      // A stalled stream measures as a perfectly settled one. Walking the rest
      // of a chain against a dead picture would look exactly like playing it.
      if (beat.dwell === 'settle' && !settleSatisfiable(stalledRef.current)) {
        setSendError(`"${sequence.title}" stopped at beat ${i + 1}: no frames are arriving, so nothing can be said to have settled.`)
        break
      }
      const verdict = await send({ name: `${sequence.id}:${beat.state}`, label: beat.state, kind: 'state', text: st.base, stateId: beat.state, from: [], ...(beat.dwell === 'settle' ? { landWhen: beat.gate } : {}) })
      // A `settle` that timed out advanced on the clock, not on the picture.
      // Measured on a live session, that is a common outcome rather than a rare
      // one — a generated scene is never still — so an author who is never told
      // will believe their pacing is being honoured when it is being waited out.
      if (beat.dwell === 'settle' && verdict !== 'evidence') {
        setPlayingSeq({ title: `${sequence.title} — beat ${i + 1} did not settle`, at: i + 1, of: plan.length })
      }
      if (typeof beat.dwell === 'object') {
        await new Promise((r) => setTimeout(r, beat.dwell === 'settle' || beat.dwell === 'input' ? 0 : beat.dwell.ms))
      } else if (beat.dwell === 'input') {
        // The author handed control back here: the walk stops, and whatever the
        // player does next is theirs. Resuming would take the world back off
        // them a moment after giving it.
        break
      }
    }
    setPlayingSeq(null)
  }

  // Esc closes. The authored hotkeys fire their beat, and WASD/arrows drive.
  //
  // `heldCommands` was a green capability chip over nothing: providers declared
  // it, the badge rendered it, the WebSocket protocol told backend authors to
  // handle `command` events, and the studio had no key handler at all beyond
  // this Escape listener. Authored `hotkey` fields were bound nowhere either.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !locked) { onClose(); return }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      // Never swallow typing.
      const el = e.target
      if (el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return

      // Position for driving, character for hotkeys — see MOVE_KEYS.
      const code = e.code
      const key = e.key.toLowerCase()
      const drive = DRIVE_KEYS[code]
      // DRIVING WINS. The starter world once shipped `hotkey: 'w'` on a
      // transition: holding W to walk fired a beat instead of driving. An
      // authored hotkey may not take a control the player needs to hold.
      const hot = drive ? undefined : available.find((b) => b.hotkey && b.hotkey.toLowerCase() === key)
      if (hot) { e.preventDefault(); void send(hot); return }

      if (drive && caps?.heldCommands && sessionRef.current) {
        e.preventDefault()
        // Which layer variant the world is being streamed on right now. The
        // inspector renders this, so it has to be the RUNTIME's answer, not the
        // author's guess.
        held.add(code)
        setHeldCodes(new Set(held))
        if (code in LOOK_KEYS) setLooking(true)
        else setMoving(true)
        if (drive === 'Front') forwardRef.current = true
        // Fire-and-forget: a dropped drive token is not worth an error banner,
        // and holding a key must not queue behind an await.
        void sessionRef.current.sendEvent({ kind: 'command', value: drive }).catch(() => {})
      }
    }
    const held = new Set<string>()
    const onUp = (e: KeyboardEvent) => {
      held.delete(e.code)
      setHeldCodes(new Set(held))
      if (![...held].some((k) => k in LOOK_KEYS)) setLooking(false)
      if (![...held].some((k) => k in MOVE_KEYS)) setMoving(false)
      if (!held.has('KeyW')) forwardRef.current = false
      // Persistent model commands: release must idle its own axis, or a key
      // tapped once drives forever.
      const stop = AXIS_STOP_TOKEN[e.code]
      if (stop && caps?.heldCommands && sessionRef.current) {
        void sessionRef.current.sendEvent({ kind: 'command', value: stop }).catch(() => {})
      }
    }
    // A key held while the window loses focus never fires keyup, which would
    // leave MOVE lit forever over a still picture.
    const onBlur = () => {
      held.clear(); setMoving(false); setLooking(false); forwardRef.current = false
      if (caps?.heldCommands && sessionRef.current) {
        void sessionRef.current.sendEvent({ kind: 'command', value: 'idle' }).catch(() => {})
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, locked, available, caps, sending])


  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Play world">
      <div className="overlay-head">
        <strong>Play</strong>
        <code className="muted" title={actWorldId}>{actWorldId}</code>
        <Pill>{providers.world.active}</Pill>
        <span className="spacer" />
        {!locked && <Button variant="ghost" onClick={onClose} text="Close" />}
      </div>

      {caps && (
        <div style={{ padding: '0 16px' }}>
          <CapabilityBadge capabilities={caps} />
        </div>
      )}

      {arcadeNote && (
        <div style={{ padding: '0 16px' }}>
          <Muted size={12}>{arcadeNote}</Muted>
        </div>
      )}

      {landNote && (
        <div style={{ padding: '0 16px' }}>
          <Muted size={12}>{landNote}</Muted>
        </div>
      )}

      {stalled && (
        <div style={{ padding: '0 16px' }}>
          <div className="diag error" role="status">
            <strong>This backend said it would send frames, and none have arrived.</strong>{' '}
            The session is open and your beats are being accepted — there is just no picture.
            Worth checking, in order: whether this network allows WebRTC (corporate networks and
            some VPNs block it), and whether the model needs a first frame — <code>lingbot-world-2</code>{' '}
            will not start from a prompt alone, so paint a seed frame when you create the world.
          </div>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: 'flex', padding: 16 }}>
        {blocked ? (
          <div className="diag error" style={{ margin: 'auto', maxWidth: 620 }}>
            <strong>This world does not pass the doctrine, so it will not open.</strong>
            <div style={{ marginTop: 8 }}>
              Playing it would stream prose the model resolves against itself. Fix these in the
              editor and press play again — nothing was started, and nothing was billed.
            </div>
            <div style={{ marginTop: 10 }}>
              {blocked.map((d, i) => (
                <div key={`${d.lint}:${d.path}:${i}`} className="diag error" style={{ marginTop: 6 }}>
                  {d.message} <code>{d.path}</code> <span className="muted">[{d.lint}]</span>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 10 }}>
              {!locked && <Button variant="ghost" onClick={onClose} text="Close" />}
            </div>
          </div>
        ) : error ? (
          <div className="diag error" style={{ margin: 'auto', maxWidth: 520 }}>
            {error}
            <div style={{ marginTop: 10 }}>
              {!locked && <Button variant="ghost" onClick={onClose} text="Close" />}
            </div>
          </div>
        ) : (
          /* The mount node is OWNED BY THE PROVIDER and must never have React
             children. Providers append a canvas/video/iframe to it imperatively;
             when React reconciled a child of its own in here (the status line),
             clearing that child wiped the provider's element with it — so the
             capability row cheerfully reported "streaming ✓" over a blank
             rectangle, for every provider. Status is now a SIBLING overlay. */
          <div className="play-stage">
            <div className="play-picture">
            <div
              ref={(el) => { mountRef.current = el; setMountEl(el) }}
              style={{ position: 'absolute', inset: 0, display: 'flex' }}
            />
            {/* Arcade layer: a REACT-OWNED sibling of the mount node, never a
                child of it — the comment on mountRef above still applies here:
                the provider owns that element, and a reconciled child inside
                it wipes whatever it just painted. Renders nothing at all (not
                even an empty wrapper) when there is no hotspot to show, so it
                never eats a click over the picture on a session with no
                vision provider configured. */}
            <Chips
              beats={available}
              tracks={tracks}
              mount={mountEl}
              sending={sending}
              disabled={!caps?.promptableEvents || !!sending || !!status}
              onFire={(b) => {
                const beat = available.find((x) => x.name === b.name)
                if (beat) void send(beat)
              }}
            />
            {status && poster && <img className="boot-poster" src={poster} alt="" />}
            {/* The status line rides ABOVE the zoom door, at the foot of the
                frame: held photograph or not, the player must always see that
                a world is coming — a silent full-screen print reads as a dead
                end. BIG, because it is the only thing on the screen during a
                boot. */}
            {status && (
              <div className="boot-status" style={{ position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 9, pointerEvents: 'none' }}>
                <Spinner /> {status}
              </div>
            )}
            {/* THE QUEST PANEL. A mission is ordered objectives with a flag
                ledger behind them, so the panel is not decoration: it reads the
                SAME flags the rail gates on (`missionProgress`), which is why a
                tick here and an unlocked action there can never disagree. */}
            {missions.map((m) => {
              const { done, activeIndex, complete } = missionProgress(m, flags)
              return (
                <div key={m.id} className={`quest${complete ? ' complete' : ''}`}>
                  <div className="quest-title">{m.title}</div>
                  {m.objectives.map((o, i) => (
                    <div
                      key={o.id}
                      className={`quest-line${done[i] ? ' done' : ''}${i === activeIndex ? ' active' : ''}`}
                    >
                      <span className="quest-tick">{done[i] ? '✓' : i === activeIndex ? '▸' : '·'}</span>
                      {o.text}
                    </div>
                  ))}
                </div>
              )
            })}

            {/* THE ENDING. A win or a lose state was authored, drawn with its
                badge, and then played exactly like any other room — the run
                simply stopped somewhere with no exits. An ending has to LAND:
                the card is what tells a player the story ended and which way it
                went, and TRY AGAIN is what makes a lose state a game rather
                than a dead end. */}
            {ending && (
              <div className={`ending-card ${ending.kind}`} role="status">
                <div className="ending-kind">{ending.kind === 'win' ? 'YOU WIN' : 'YOU LOSE'}</div>
                {/* An act ending and a BOOK ending are different sizes of event.
                    Without this the player who finished the whole campaign saw
                    the same "YOU WIN" as someone who finished act one, and
                    nothing said the story was over. */}
                {campaign && actId && stateId && campaignFinished(campaign.graph, actId, stateId, ending.kind) && (
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }} data-testid="campaign-finished">
                    That is the end of {campaign.title || 'the book'}.
                  </div>
                )}
                <div className="ending-title">{ending.title}</div>
                {ending.subtitle && <div className="ending-sub">{ending.subtitle}</div>}
                <div className="row" style={{ gap: 8, marginTop: 14, justifyContent: 'center' }}>
                  <Button variant="primary" text="Try again" onClick={() => void restart()} />
                  <Button variant="ghost" text="Close" onClick={onClose} />
                </div>
              </div>
            )}

            {!showInspector && (
              <div className="playspect-open" style={{ display: 'flex', gap: 6 }}>
                {!choiceMode && (
                  <Button
                    onClick={() => setShowInspector(true)}
                    title="show the live graph + prompt"
                    text="▦ inspector"
                  />
                )}
                {/* THE CINEMA'S ONE EXIT. A deployed film has no studio to
                    return to, but it must still be stoppable: this ends the
                    metered session and stands back at the title card. */}
                {choiceMode && locked && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      const s = sessionRef.current
                      sessionRef.current = null
                      if (s) void s.dispose().catch(() => {})
                      window.location.reload()
                    }}
                    title="end the session and return to the title card"
                    text="■ stop"
                  />
                )}
                {/* A choice film has no sound state to flip: the first press is
                    the gesture that arms audio, permanently. A toggle that
                    flips nothing is a lie on screen. */}
                {!choiceMode && (
                  <Button
                    variant="ghost"
                    onClick={toggleSound}
                    title="unmute the world's own audio"
                    text={soundOn ? '🔊 on' : '🔇 off'}
                  />
                )}
              </div>
            )}

            {/* A BOOKEND. The intro sits over a booting stream; the outro over a
                finished one. Both resolve on `ended` OR `error` and both are
                capped by the same timeout the seam cuts use — a clip that never
                arrives must not hold a world hostage at either end. */}
            {bookend && (
              <video
                className="cutscene"
                src={bookend.video}
                autoPlay
                playsInline
                muted
                data-bookend={bookend.kind}
                onEnded={() => (bookend.kind === 'intro' ? endIntro() : setBookend(null))}
                onError={() => (bookend.kind === 'intro' ? endIntro() : setBookend(null))}
              />
            )}

            {/* OUT OF A REPLAY. The console may be closed while a memory is
                still streaming, and the way back must not live only inside it
                — a player who shut the console would be trapped in the memory
                with the graph offering moves that belong to the room. */}
            {replaying && (
              <Button
                className="playspect-open"
                variant="ghost"
                text="◂ back to the suite"
                title="leave the replay and re-enter the suite"
                onClick={() => void returnFromReplay()}
              />
            )}

            {/* THE CONSOLE. Over the picture, not instead of it: the world
                keeps breathing behind a terminal, which is what makes it a
                thing in the room rather than a menu. */}
            {terminal && (
              <div className="terminal" role="dialog" aria-label={`Terminal: ${terminal.beat}`}>
                <div className="terminal-log">
                  {termLog.map((line, i) => (
                    <div key={i} className={line.who === 'you' ? 'terminal-you' : 'terminal-it'}>
                      {line.who === 'you' ? '> ' : ''}{line.text}
                    </div>
                  ))}
                  {termBusy && <div className="terminal-it">…</div>}
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <TextInput
                    id="terminal-input"
                    aria-label="Type to the terminal"
                    value={termInput}
                    onChange={(e) => setTermInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void askTerminal() } }}
                    placeholder="type a question"
                    spellCheck={false}
                  />
                  <Button variant="ghost" text="ASK" busy={termBusy} onClick={() => void askTerminal()} />
                  <Button variant="ghost" text="✕" aria-label="Close the terminal" onClick={() => setTerminal(null)} />
                </div>
              </div>
            )}

            {/* THE CLIP, full-bleed over the live picture. It resolves the wait
                on `ended` OR on `error` — a missing file is survivable by
                design, and the timeout behind it catches a URL that neither
                plays nor fails. */}
            {playingCut && (
              <>
                <video
                  className="cutscene"
                  src={playingCut.video}
                  autoPlay
                  playsInline
                  muted={!soundOn}
                  data-cutscene={playingCut.id}
                  onEnded={() => cutDoneRef.current?.()}
                  onError={() => cutDoneRef.current?.()}
                />
                {playingCut.subtitle && (
                  <div className="cut-caption" role="status">{playingCut.subtitle}</div>
                )}
              </>
            )}

            {/* THE DIRECTOR'S COMPOSER. Inside `.play-picture` on purpose: it is
                the positioned ancestor the floating card anchors to, so the card
                sits over the VIDEO and never over the beat rail underneath —
                the same rule that moved it off the lint panel in the editor.
                Collapsed to its pill by default, because during play the picture
                is the thing you are looking at. */}
            {!error && !blocked && !choiceMode && (
              <AgentBar
                worldId={actWorldId}
                rev={rev}
                reload={async () => {
                  const sc = await store.getScene(actWorldId)
                  setScene({ states: sc.states, events: sc.events || [] })
                  setBeats(beatsFrom(sc, cutscenes))
                  setRev(sc.rev ?? '')
                }}
                toast={() => {}}
                startCollapsed
                label="type what happens next"
                onSubmit={direct}
              />
            )}
            {/* NARRATION. Under the picture, non-blocking, and never sent to the
                model: this is UI display copy, not a generation prompt, which
                is also why no lint polices its prose. A negation reads
                perfectly to a person and renders wrong to a world model, and
                this is the one field here a person reads. */}
            {/* The caption shows even while the world is still connecting —
                that is exactly when the homecoming lines are spoken, and a
                voice over a silent boot needs its words on screen. */}
            {narration && narrationShown && !terminal && begun && (
              <div className={choiceMode ? 'narration narration-story' : 'narration'} role="status">{narration}</div>
            )}

            {/* THE TITLE CARD — its press is the film's gesture: begin arms
                sound (music + voice), which a browser will not allow before a
                click. Nothing of the story speaks or shows before it. */}
            {choiceMode && !begun && !error && (
              <div className="title-card" role="dialog" aria-label="Begin">
                <div className="title-name">{worldRef.current?.name ?? ''}</div>
                <div className="title-sub">{(worldRef.current?.['tagline'] as string | undefined) ?? ''}</div>
                <Button
                  variant="primary"
                  className="begin-btn"
                  text="▶ begin"
                  onClick={() => {
                    setBegun(true)
                    if (!soundRef.current) toggleSound()
                  }}
                />
              </div>
            )}

            {/* THE STORY HUD — whose seat this is. A live world under choice
                cards reads as "a room with a menu" unless the frame says what
                the player is doing there; the line rides the world doc.
                Story chrome waits for the world: no HUD over a connecting
                screen. */}
            {choiceMode && begun && !status && !ending && !error && (
              <div className="story-hud" role="status">
                <span className="story-hud-title">{worldRef.current?.name ?? 'THE TAKE'}</span>
                <span className="story-hud-sep">·</span>
                {/* A scene can teach its own verb — the bike rides, the rooms
                    walk. Fall back to the world's line when it doesn't. */}
                <span>
                  {(storyHudLine(worldRef.current, stateId)
                    ?? (worldRef.current?.['hudLine'] as string | undefined)
                    ?? "you're on the earpiece — make the calls")}
                </span>
              </div>
            )}

            {/* THE ZOOM DOOR — the photograph held up, scaling into its world. */}
            {door && (
              <div key={door.id} className={`zoom-door${doorDone ? ' leaving' : ''}`} aria-hidden>
                <img src={door.src} alt="" />
              </div>
            )}

            {/* THE CHOICE DECK — story mode's only verbs. A choice film runs
                on two or three big cards over the live picture; the beat rail,
                the drive caps and the composer are authoring chrome and stay
                out. Disabled while a beat is in flight; the clip that plays
                over the deck hides it until the next scene is standing. Cards
                never hang in a void either — they appear when the room does. */}
            {choiceMode && available.length > 0 && begun && !status && !error && (
              <div className="choice-deck" role="group" aria-label="Your call">
                {available.map((b) => {
                  // A world may hang a PHOTOGRAPH on a choice — the cards become
                  // the pictures lying on the table, and pressing one is
                  // picking it up.
                  const photo = (worldRef.current?.['photoCards'] as Record<string, string> | undefined)?.[b.name]
                  return (
                    <button
                      key={b.name}
                      className={photo ? 'choice-card choice-card-photo' : 'choice-card'}
                      onClick={() => void send(b)}
                      disabled={!caps?.promptableEvents || !!sending || !!status || !!playingCut}
                      title={b.text}
                    >
                      {photo && <img className="choice-photo" src={photo} alt="" />}
                      {sending === b.name ? <span className="choice-key">…</span> : <span className="choice-key">{b.hotkey ?? '▸'}</span>}
                      <span className="choice-label">{b.label}</span>
                    </button>
                  )
                })}
              </div>
            )}
            {/* THE BLIP. What is left of a drive, in a world that cannot be
                asked how far anything is — the number is what the player has
                travelled, which is the only distance there is. */}
            {beats
              .filter((b) => b.waypoint && stateId && b.from.includes(stateId))
              .map((b) => {
                const spec = b.waypoint
                if (!spec) return null
                const hud = waypointHud(spec, odometer[b.name] ?? spec.distanceM)
                return (
                  <div key={`wp:${b.name}`} className={`waypoint${hud.approaching ? ' approaching' : ''}`} role="status">
                    <span className="waypoint-label">{hud.label}</span>
                    <span className="waypoint-dist">{hud.text}</span>
                  </div>
                )
              })}
            {playingSeq && (
              <div className="seq-banner" role="status">
                ▶ {playingSeq.title} <span className="muted">· beat {playingSeq.at} of {playingSeq.of}</span>
              </div>
            )}
            {directNote && (
              <div className="direct-note" role="status">{directNote}</div>
            )}
            {/* THE ACT. A campaign changes the world under the player mid-run,
                so it has to say which chapter this is and what came with them —
                a story that silently swaps worlds reads as a bug. */}
            {campaign && actId && (
              <div className="act-banner" role="status">
                <strong>{campaign.graph.acts.find((a) => a.actId === actId)?.title ?? actId}</strong>
                <span className="muted" style={{ marginLeft: 8, fontSize: 11 }}>
                  {goldenIndex(campaign.graph, actId) >= 0
                    ? `act ${goldenIndex(campaign.graph, actId) + 1} of ${campaign.graph.goldenThread.length}`
                    : 'off the spine'}
                </span>
                {handoffNote && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{handoffNote}</div>}
                {deadEnd && (
                  <div className="warn" style={{ fontSize: 11, marginTop: 2 }} data-testid="campaign-dead-end">
                    Dead end — {deadEnd} Rewind to a choice point to take the other door.
                  </div>
                )}
              </div>
            )}
            {rewindTarget && !ending && (
              <Button
                className="rewind-btn"
                variant="ghost"
                onClick={() => {
                  const st = scene.states[rewindTarget]
                  if (!st) return
                  void send({ name: rewindTarget, label: rewindTarget, kind: 'state', text: st.base, stateId: rewindTarget, from: [] })
                }}
                title={`go back to ${rewindTarget} — the other door is still there`}
                text={`↶ rewind to ${rewindTarget}`}
              />
            )}
            {/* THE CONTROLS, lit as they are held. A player pressing a key and
                seeing nothing move cannot tell a dead control from a world that
                ignored them — which is precisely what hid the layout bug, where
                driving was keyed on the character and an AZERTY board sent "z"
                for the W position. Only while the transport can take a held
                command: showing caps a provider will never receive would be the
                same false promise one layer up. */}
            {/* Drive keys stay lit in story mode too: the room between
                photographs is a live world the player can walk — that walk is
                the point of a shoebox that empties into a room. */}
            <DriveKeys held={heldCodes} enabled={!!caps?.heldCommands && !error} />
            </div>

            {showInspector && (
              <PlayInspector
                states={scene.states}
                events={scene.events}
                currentState={stateId}
                trail={trail}
                moving={moving}
                looking={looking}
                sending={sending}
                sendingNote={progressNote}
                probing={probing}
                paused={paused}
                disabled={!caps?.promptableEvents || !!status}
                onPause={() => setPaused((p) => !p)}
                onHide={() => setShowInspector(false)}
                onJump={(id) => {
                  const st = scene.states[id]
                  if (!st) return
                  void send({ name: id, label: id, kind: 'state', text: st.base, stateId: id, from: [] })
                }}
                episode={episodeSize}
                replay={(when, eventName) => {
                  const rec = recordRef.current
                  if (!rec) return null
                  // Count from where the LIVE gate counts, once it has actually
                  // been waited on — otherwise from this state's entry.
                  //
                  // Never from the start of the session: a gate on this
                  // transition is a claim about now, and counting hits from
                  // three rooms ago would pass gates the player never satisfied
                  // here.
                  //
                  // The two are DIFFERENT QUESTIONS and the readout says which
                  // one it answered. Measured live: while the event was still
                  // streaming its phases the replay reported "✓ 5.5s" from
                  // state entry; the moment the live gate began watching, the
                  // same row turned to "✕ 0 hits" and then tracked it exactly
                  // (live "evidence 1/2" ↔ replay "1 hit"). Both readings were
                  // honest and only one of them was about something that had
                  // happened.
                  const ranAt = markTime(rec, `gate:${eventName}`)
                  const from = ranAt ?? (stateId ? markTime(rec, `state:${stateId}`) ?? 0 : 0)
                  const r = replayGate(when, rec, from)
                  return {
                    passed: r.passed,
                    firedAtMs: r.firedAtMs,
                    hits: r.hits.length,
                    groundable: r.groundable,
                    ran: ranAt !== null,
                  }
                }}
                onTake={(e) => {
                  const beat = beats.find((b) => b.name === e.name)
                  if (beat) void send(beat)
                }}
              />
            )}
          </div>
        )}
      </div>

      {/* The events you authored, as buttons. Without this the capability row
          above was describing something the studio could not do either way.
          Story mode replaces this rail with the choice deck over the picture. */}
      {!choiceMode && beats.length > 0 && !error && (
        <div style={{ padding: '0 16px 14px' }}>
          <div className="row" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 12 }}>
              {stateId ? <>in <code>{stateId}</code> — send a beat:</> : 'send a beat:'}
            </span>
            {beatBarNote(stateId, available.length) && (
              <span className="muted" style={{ fontSize: 12 }}>
                {beatBarNote(stateId, available.length)}
              </span>
            )}
            {/* VISIBLE-BUT-LOCKED. A gated action that simply vanishes reads
                as a broken world; one that stays, disabled, saying what
                unblocks it reads as a world with a lock in it. Only beats whose
                author wrote a reason appear — the rest stay hidden on purpose. */}
            {lockedBeats(beats, stateId, flags, used).map((b) => (
              <Button key={`locked:${b.name}`} variant="ghost" className="beat-locked" disabled title={b.lockedHint}>
                🔒 {b.label}
                <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>{b.lockedHint}</span>
              </Button>
            ))}
            {/* SET-PIECES, offered where they START. A sequence is a chain of
                states played as one unit, so it belongs beside the beats rather
                than in a menu somewhere else. */}
            {sequencesFrom(sequences, stateId).map((q) => (
              <Button
                key={`seq:${q.id}`}
                variant="ghost"
                className="beat-sequence"
                onClick={() => void runSequence(q)}
                disabled={!caps?.promptableEvents || !!sending || !!status || !!playingSeq}
                title={`play the set-piece "${q.title}" — ${q.beats.length} beats`}
              >
                ▶ {q.title}
              </Button>
            ))}
            {available.map((b) => (
              <Button
                key={b.name}
                variant="ghost"
                onClick={() => void send(b)}
                disabled={!caps?.promptableEvents || !!sending || !!status}
                title={
                  caps && !caps.promptableEvents
                    ? 'This backend does not accept authored events — see the warning above.'
                    : b.text
                }
              >
                {sending === b.name ? <><Spinner /> {b.label}</> : b.label}
                {b.hotkey && <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>{b.hotkey}</span>}
              </Button>
            ))}
          </div>
          {sendError && <div className="diag error" style={{ marginTop: 8 }}>{sendError}</div>}
        </div>
      )}
    </div>
  )
}

/**
 * The world as the player needs it: the entrance state's prose, its first frame,
 * and every authored event reduced to the text that would be pushed.
 *
 * Tolerant on purpose — a world that cannot be read still plays, it just opens
 * without its own opening line, which beats refusing to play at all.
 */
/**
 * Every authored event, as something the player can send.
 *
 * Its own function because the rail is now rebuilt DURING play: the director
 * authors new events into the live world, and a beat list computed once at
 * connect time would leave them unreachable — authored, drawn in the inspector,
 * and impossible to press.
 */
function beatsFrom(
  scene: { states: Record<string, SMState>; events?: SMEvent[] | undefined },
  cutscenes: readonly SMCutscene[] = [],
): Beat[] {
  return (scene.events || [])
    .filter((e) => !e.hidden)
    .map((e) => {
      // An event that names a destination MOVES the machine, so it goes out as
      // a state event; anything else only recolours the state it is already in.
      // A destination is a state OR a cutscene. Without the second half a
      // transition pointing at a cut is not a MOVE at all — it goes out as a
      // prompt, the cut never plays, and the machine stays where it was.
      const dest = e.to ? scene.states[e.to] : undefined
      const isCut = !!e.to && cutscenes.some((c) => c.id === e.to)
      const moves = !!(e.to && (dest || isCut))
      return {
        name: e.name,
        // `detail` is the event's human line (the rail and the choice deck show
        // it); the name is only a fallback so a bare event still reads.
        label: e.detail || e.name.replace(/_/g, ' '),
        kind: moves ? ('state' as const) : ('prompt' as const),
        // A transition's prose lives on the state it moves TO unless the event
        // overrides it. Fall back to the name rather than sending an empty
        // string, which reads to a backend as "draw nothing in particular".
        text: e.base || dest?.base || e.detail || e.name.replace(/_/g, ' '),
        stateId: e.to,
        from: Array.isArray(e.from) ? e.from : e.from ? [e.from] : [],
        hotkey: e.hotkey || undefined,
        anchor: e.anchor,
        requires: e.requires,
        grants: e.grants,
        oneShot: e.oneShot,
        lockedHint: e.lockedHint,
        phases: e.phases,
        landWhen: e.landWhen,
        camera: e.camera,
        movement: e.movement,
        minPlayMs: e.minPlayMs,
        autoAfterMs: e.autoAfterMs,
        narration: e.narration,
        drive: e.drive,
        drivePulseMs: e.drivePulseMs,
        waypoint: e.waypoint,
        terminal: e.terminal,
      }
    })
}

async function readOpening(
  store: ReturnType<typeof useClient>['store'],
  worldId: string,
  startState?: string | undefined,
  variantLabel?: string | undefined,
): Promise<{
  prompt?: string | undefined
  firstFrameUrl?: string | undefined
  beats: Beat[]
  stateId?: string | undefined
  scene: { states: Record<string, SMState>; events: SMEvent[] }
  missions: SMMission[]
  sequences: SMSequence[]
  cutscenes: SMCutscene[]
  world: SMWorld
  rev: string
  /** The entrance's display copy, if it has any. */
  narration?: string | undefined
}> {
  const [doc, rawScene] = await Promise.all([store.getWorld(worldId), store.getScene(worldId)])
  // The hosted API wraps the world in an envelope; the local store does not.
  const rawWorld = unwrapWorldDoc(doc)
  // Where the run STARTS. Normally the entrance; for an A/B arm, the state
  // being compared — booted on the world's own entrance seed either way, which
  // is what keeps the two arms comparable.
  const entranceId = (startState && rawScene.states[startState] ? startState : undefined)
    ?? rawWorld.entrance?.state
    ?? Object.keys(rawScene.states)[0]
  // The B side, if one was asked for. An unknown label plays A rather than
  // silently playing something else.
  const world = entranceId && variantLabel ? worldWithVariant(rawWorld, entranceId, variantLabel) : rawWorld
  const scene = world.scene?.states ? { ...rawScene, states: world.scene.states } : rawScene
  const entrance = entranceId ? scene.states[entranceId] : undefined

  const beats = beatsFrom(scene, world.cutscenes ?? [])

  return {
    prompt: entrance?.base,
    firstFrameUrl: world.entrance?.image?.src,
    beats,
    stateId: entranceId,
    scene: { states: scene.states, events: scene.events || [] },
    missions: world.missions ?? [],
    sequences: world.sequences ?? [],
    cutscenes: world.cutscenes ?? [],
    world,
    rev: scene.rev ?? '',
    narration: narrationFor(world, entrance),
  }
}

function isApiError(e: unknown): e is ApiError {
  return typeof e === 'object' && e !== null && 'status' in e
}

/** A state may carry `seedFrame: { src }` — an authored or painted image the
 *  state boots a fresh session from. The store passes unknown fields through
 *  untouched, so the read is guarded here at the only reader rather than banned
 *  at the boundary. */
function stateSeedSrc(state: SMState | undefined): string | undefined {
  if (!state) return undefined
  const seed = (state as { seedFrame?: unknown }).seedFrame
  if (typeof seed !== 'object' || seed === null) return undefined
  const src = (seed as { src?: unknown }).src
  return typeof src === 'string' && src.length > 0 ? src : undefined
}

/** A state's own layered prompt — base plus the STATIC halves of its camera and
 *  movement pairs, the layers that hold while no input is pressed. A re-seed
 *  boots standing still, so the dynamic halves stay out. */
function statePrompt(state: SMState | undefined): string | undefined {
  if (!state?.base) return undefined
  return [state.base, state.camera?.static, state.movement?.static].filter(Boolean).join(' ')
}

/** Status-specific copy for the failures a provider can surface on connect. */
function playErrorMessage(e: unknown): string {
  if (isApiError(e)) {
    switch (e.status) {
      case 401:
      case 403:
        return `The provider rejected your credentials (${e.status}). ${e.detail || 'Check the key in Settings.'}`
      case 402:
        return `Playback is blocked by your plan limit (402). ${e.detail || 'Check usage/billing, then try again.'}`
      case 404:
        return `World not found (404). ${e.detail || "It may have been deleted, or isn't published yet."}`
      case 503:
        return `The play runtime is temporarily unavailable (503). ${e.detail || 'Please try again in a moment.'}`
      default:
        return e.detail || e.message || 'Could not start a play session.'
    }
  }
  // Provider errors carry actionable prose (missing SDK, unreachable endpoint,
  // rejected key) — show it rather than flattening to a generic failure.
  return e instanceof Error ? e.message : 'Could not start a play session.'
}
