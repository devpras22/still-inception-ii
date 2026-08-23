/**
 * A line to READ, derived from a line written to be RENDERED.
 *
 * `narrate` is stamped on worlds the book pipeline generated. For those, the
 * narration panel derives a story-grounding line from a state's `base` when the
 * state carries no authored `narration`. Hand-authored worlds are left alone,
 * because a hand-authored world should show only what its author wrote.
 *
 * The derivation is not a summary and not a model call. It is a STRIP: a base
 * opens with a camera instruction and may close with a style tail, and both are
 * addressed to a diffusion model rather than to a person. Take them off and
 * what remains is a sentence about the place.
 *
 * This is a heuristic over authored prose and is treated as one — it returns
 * nothing rather than guessing when what is left is too short to be a sentence.
 * The preambles below are the forms this studio's own worlds and kernel prompt
 * actually use. A different generator writes different ones — extend the list
 * rather than trying to match camera prose in general.
 */
import type { SMState, SMWorld } from '../world'

/** Camera preambles this studio writes, longest first so the fuller form wins. */
const PREAMBLES = [
  /^a\s+third-person\s+rear-view\s+shot\s+of\s+/i,
  /^a\s+rear-view\s+shot\s+of\s+/i,
  /^a\s+third-person\s+shot\s+of\s+/i,
  /^[^,]{0,60},\s*seen from behind,?\s*/i,
]

export function deriveNarration(world: SMWorld, state: SMState | undefined): string | undefined {
  const base = state?.base?.trim()
  if (!base) return undefined
  let s = base
  for (const re of PREAMBLES) {
    const m = re.exec(s)
    if (m) { s = s.slice(m[0].length); break }
  }
  const tail = world.styleTail?.trim()
  if (tail && s.includes(tail)) s = s.split(tail).join(' ')
  s = s.replace(/\s+/g, ' ').trim().replace(/[.,;:\s]+$/, '').trim()
  if (s.length < 3) return undefined
  return s.charAt(0).toUpperCase() + s.slice(1) + '.'
}

/**
 * What the player reads here: what the author wrote, else a derived line when
 * the world asked for one. Authored narration always wins — the derivation is
 * a fallback for worlds nobody hand-narrated, never an override of one.
 */
export function narrationFor(world: SMWorld, state: SMState | undefined): string | undefined {
  const authored = state?.narration?.trim()
  if (authored) return authored
  return world.narrate ? deriveNarration(world, state) : undefined
}
