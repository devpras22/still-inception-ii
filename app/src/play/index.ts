/**
 * Play — running an authored world against a live world model.
 *
 * Reads the world, opens a session on whichever provider is configured, sends
 * the opening state, and offers the beats that are legal from wherever the
 * machine is standing. Two surfaces sit on top of that: CHIPS pinned to the
 * objects an interaction happens at (`Chips.tsx`, gated by the rules in
 * `anchors.ts`) and the play-time INSPECTOR (`Inspector.tsx`) showing the
 * traversal over the exact prompt being streamed.
 *
 * Belongs here: the player surface, the beat rail, the current-state model, the
 * chip rules (how a stream of detector boxes becomes something you can hit),
 * the ARRIVAL rules (what the picture must show before a destination is allowed
 * to land, and what a trigger zone watches for during free roam), and the
 * watchdog that says so when a backend promises frames and sends none, and the
 * EPISODE RECORD — what a session actually showed, so an authored gate can be
 * replayed over it offline instead of guessed at — and the DRIVE plan: which
 * control tokens an authored move presses while it plays, kept as a value so
 * "the prompt and the channel agree" is something a test can check — and
 * SET-PIECES, whose `settle` dwell is only meaningful while frames are actually
 * arriving (`settleSatisfiable`), because a frozen picture measures as a
 * perfectly still one — and CUTSCENES, whose only hard rule is that a clip
 * nobody has made yet must not become a wall — and TERMINALS, whose authored
 * truth ledger is filtered by the player's flags BEFORE the model sees it,
 * because a fact it was never told is a fact it cannot leak — and the NARRATION
 * a player reads, which is what the author wrote, or a line derived from the
 * state's base by stripping the camera instruction off it when the world asked
 * for that and nobody wrote one — and the BOOKENDS, an intro that covers a boot
 * rather than delaying it and an outro that has to be earned once.
 * Belongs elsewhere: the transport itself (provider/world/*), the detector
 * behind the boxes (provider/vision/*), and the graph being played (world/).
 */
export { PlayModal } from './Player'
export { ANCHOR } from './anchors'
export { EVIDENCE, evidenceMet, measureFrame, autoEligible, gateBudget } from './evidence'
export {
  emptyRecord, specFromLandWhen, framePasses, detectPasses, hitEvents, markTime, replayGate, promptForBeat,
} from './episode'
export type { EpisodeRecord, EpisodeFrame, EpisodeDetect, EpisodeMark, EvidenceSpec } from './episode'
export { driveTokens, hasDrive, tickOdometer, waypointHud, approachDistance, DRIVE_RELEASE, WAYPOINT_SPEED_MS } from './drive'
export type { WaypointSpec } from './drive'
export { sequencePlan, sequencesFrom, settleSatisfiable, SequenceError, SETTLE_GATE } from './sequence'
export { resolveDestination, cutscenesFrom, CUTSCENE_TIMEOUT_MS } from './cutscene'
export { sayableFacts, terminalSystem } from './terminal'
export { deriveNarration, narrationFor } from './narrate'
export { outroDue, bootAfterIntro } from './bookends'
export type { Outro } from './bookends'
export type { TerminalSpec } from './terminal'
export type { PlannedBeat } from './sequence'
