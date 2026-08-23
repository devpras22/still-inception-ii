/**
 * Stagecraft — a small language for authoring worlds, and the gate that keeps
 * a bad one from ever reaching a player.
 *
 * Three layers — fragments → evidence → programs — compiling to the SAME
 * `SMWorld` the store already holds. There is no parser and no new syntax: it
 * is a TypeScript eDSL, so autocomplete and `tsc` are the front end, and the
 * doctrine (`world/doctrine.ts`) is the back end — a world that breaks a rule
 * fails to COMPILE, with the exact field path, before anything renders it.
 *
 * Belongs here: fragments and the whitespace law, the evidence algebra, the
 * immutable program builder, and `compile()`/`check()`.
 * Belongs elsewhere: the rules themselves (world/doctrine.ts — they are facts
 * about worlds, not about this language) and anything that runs a world (play/).
 */
export { frag, Fragment, both, normalizeWhitespace, textOf } from './fragments'
export type { Textish } from './fragments'
export { see, either, matches, Evidence, EvidenceError } from './evidence'
export { world, Program, CompileError, candidateFor } from './program'
export type { StateSpec, EventSpec, PhaseSpec, WorldMeta } from './program'
