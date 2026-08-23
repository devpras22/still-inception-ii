/**
 * Author — everything involved in making a world.
 *
 * Creating one from a premise, editing the graph, inspecting and rewriting a
 * state or event, running a language model over it, grounding objects in a
 * frame, and moving between versions.
 *
 * Belongs here: every authoring surface, and the agent/ corner — the kernel
 * that authors a whole world from a premise, and the editor that changes one
 * that already exists, with the panel and prompt-and-apply logic behind both.
 * Creating itself is one interaction core (`useComposer`) behind one surface:
 * `Composer`, the compact card, and `FloatingComposer`, the collapsed pill that
 * floats it over every screen. There is no create PAGE — authoring is a gesture
 * you make from where you already are.
 * and never drift into two create flows.
 * `Book` is the one exception, and earns it: a whole BOOK is not more of a
 * premise, it is a different product — several worlds joined into a campaign,
 * minutes of authoring, and a result that is a story rather than a place. It
 * gets a screen because the path existed with no door in the studio at all
 * until now.
 * The kernel composer (`AgentBar`) is exported because it is the ONE chat in
 * this studio: play/ mounts the same component with its own `onSubmit` so a
 * typed action mid-play is staged by the director instead of edited into a
 * graph. Two destinations, one conversation.
 * Belongs elsewhere: what a world IS (world/) and what happens when you press
 * Play (play/). This domain writes through the world store; it never persists
 * anything itself.
 */
export type { EditorSelection, EditorPanelProps } from './types'
export { useComposer, PREMISE_POOL } from './useComposer'
export type { ComposerViewModel } from './useComposer'
export { Composer } from './Composer'
export type { ComposerProps } from './Composer'
export { FloatingComposer } from './FloatingComposer'
export { GraphEditor } from './GraphEditor'
export { Book } from './Book'
export { AgentBar } from './agent/AgentBar'
export { runLocalEdit, LocalEditError } from './agent/edit'
export { runGeneration, GenerationError } from './agent/generate'
export type { GenerationResult } from './agent/generate'
