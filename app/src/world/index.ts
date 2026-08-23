/**
 * World — the artifact this studio exists to make.
 *
 * A world is a small state machine: states hold the prose describing what the
 * camera sees, events move between them. This domain owns what a world IS (its
 * shape and the wire types), where it LIVES (the store, local or hosted, behind
 * one interface), and how a collection of them is shown.
 *
 * Belongs here: the world/state/event types, the store and its drivers, graph
 * operations and the vocabulary of ops that edit them, the list views and the
 * card one world renders as, and the narrowers that turn an unknown value at a
 * boundary — a failed store call, a batch of ops from the CLI or an agent, the
 * hosted API's world envelope — into something typed and renderable (the store
 * owns these shapes, so world owns their guards). The DOCTRINE — what makes a
 * world playable — lives here too: it is a fact about worlds, checked over the
 * world's own shapes. A MISSION lives here for the same reason: ordered
 * objectives are a fact about a world, and they COMPILE into the states,
 * events, flags and endings the graph already holds rather than sitting beside
 * it as a second description of the same quest. That includes its
 * CREATOR-FACING half: a rule's plain
 * title, what it means and how to fix it, and the op batch for the one fix safe
 * enough to apply on a click. A lint that only a compiler can read is a lint an
 * author cannot act on, and the translation is as much a fact about the rule as
 * the rule is.
 *
 * Two things joined this domain later and belong here for the same reason. A
 * CAMPAIGN is several worlds with a spine — a macro-graph over worlds that
 * already live in the store, with its own lints, which are a fact about the
 * chain in the way the doctrine is a fact about one world. And a PROMPT
 * VARIANT is an alternate way to say a state, so `worldWithVariant` (the A/B
 * swap onto one shared seed) is a transformation of a world, not a feature of
 * the surface that plays it. A DRIVE is authored here for the same reason and
 * TRANSLATED in play/: which controls a move presses is part of the move; which
 * token says so is the transport's business. A STORY belongs here for the same
 * reason as a mission: the logline and arc are facts about the world, and the
 * BEATS are the record of what happened in it — the director's memory, kept
 * with the thing it remembers rather than in the surface that writes it. A
 * CUTSCENE is a fact about a seam in the graph for the same reason. A mission
 * built from a probed frame also owns the PROOF of its own grounding: the nouns
 * the detector found are stored beside it, so `missionGrounding` can answer
 * whether its objectives kept the rule without re-running a probe. Evidence
 * for a guarantee is a fact about the world, not a detail of the run that
 * produced it.
 *
 * `verify.ts` exports the verdict and its critique; a `countErrors` helper that
 * lived beside them was deleted for want of a caller.
 * Belongs elsewhere: how a world is edited (author/), how it is played (play/),
 * and which backend draws it (provider/). The RECORD of a session — what the
 * pixels actually did — is play/'s, even though the gate it answers for was
 * authored here.
 */
export type {
  SMWorld, SMScene, SMState, SMEvent, SMEventAnchor, SMEventPhase, SMLandWhen,
  SMObjective, SMMission, LayerPair,
  WorldListItem, WorldList, Diagnostic, GraphWriteResult, VersionNode,
  Hotspot, PublicOp, ApiError,
} from './types'
export { AlakazamClient, PUBLIC_OPS, toPublicOps } from './api'
export { pickWorldStore } from './store'
export { unwrapWorldDoc } from './store/types'
export type { SMPromptVariant, SMDrive, SMSequence, SMSequenceBeat, SMStory, SMCutscene } from './api'
export type { WorldStore, NullablePatch, SceneResult, WorldDocument } from './store/types'
export { runDoctrine, PROMPT_BUDGET } from './doctrine'
export { compileMission, missionGrounding, missionProgress, MissionError, DEFAULT_PROXIMITY } from './mission'
export { verifyWorld, critique, reachableFrom, worldWithVariant } from './verify'
export type { WorldVerdict, VerifyOpts } from './verify'
export type { MissionSpec, CompiledMission } from './mission'
export { lintTitle, lintWhat, canAutoFix, autoFixOps, DEFAULT_MIN_PROXIMITY } from './lintHelp'
export {
  actMap, campaignFinished, campaignHasErrors, carryFlagsThrough, exitStatesFor, goldenIndex, goldenThreadReaches,
  handoffFor, lintCampaign, reachableActs, resolveEdge,
} from './campaign'
export type { Campaign, CampaignActRef, CampaignDiagnostic, CampaignEdge, CampaignEdgeKind, CampaignGraph } from './campaign'
export { toDiagnostics, toApiFailure } from './failure'
export type { ApiFailure } from './failure'
export { Worlds } from './Worlds'
export { Community } from './Community'
export { WorldCard } from './WorldCard'
