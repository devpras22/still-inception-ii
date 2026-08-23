/**
 * Which authoring path a request wants.
 *
 * Three leaves author a world and they are not variations of one another:
 * `author.generate` builds a place from a premise, `author.chapter` follows
 * prose that already exists, and `author.quest` probes a frame and grounds a
 * mission on what the detector really found. Choosing between them is a
 * decision, and this domain owns it.
 *
 * It lives here rather than inline in the composer for the reason
 * `authoringPathFor` was pulled out of the composer before it: inline, the only
 * thing holding the routing was a typecheck, and a test that deleted it
 * entirely stayed green. It lives here rather than in `chapter.ts` because
 * chapter does not own quest — a module that owns one arm of a choice should
 * not own the choice.
 */
import { authoringPathFor } from './chapter'

export type AuthoringLeaf = 'author.quest' | 'author.chapter' | 'author.generate'

/**
 * `quest` is what the author ASKED for; `canProbe` is whether this studio can
 * honour it. They are separate arguments on purpose: a quest without an eye is
 * a mission grounded on nothing, which is the one thing that path exists to
 * prevent, so the capability overrules the request rather than failing later.
 * The surface disables the control for the same reason — this is the second
 * line, for a caller that did not.
 */
export function authoringLeafFor(text: string, opts: { quest: boolean; canProbe: boolean }): AuthoringLeaf {
  if (opts.quest && opts.canProbe) return 'author.quest'
  return authoringPathFor(text) === 'chapter' ? 'author.chapter' : 'author.generate'
}

/**
 * The input shape that leaf expects. `author.chapter` reads PROSE and takes
 * `text`; the other two take a `premise`. Keeping this beside the choice means
 * a caller cannot pick a leaf and then hand it the wrong field.
 */
export function authoringInputFor(leaf: AuthoringLeaf, worldId: string, text: string): Record<string, string> {
  return leaf === 'author.chapter' ? { world: worldId, text } : { world: worldId, premise: text }
}
