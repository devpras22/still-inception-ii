/**
 * A console in the world, and the one rule that makes it worth having.
 *
 * A server-side design keeps a terminal's persona and truth ledger behind an
 * API, passing the live flag set each turn so the server decides who is
 * speaking and what is sayable. There is no server here, so the ledger is
 * authored into the world instead — and the interesting property survives
 * the move intact:
 *
 *   A FACT THE MODEL WAS NEVER TOLD IS A FACT IT CANNOT LEAK.
 *
 * Gated facts are FILTERED OUT before the prompt is built, not marked secret
 * inside it. The difference is the whole security model of a diegetic console:
 * "do not mention the reactor" is an instruction a model may fail to follow,
 * while a sentence that is not in the context cannot be recited from it.
 */
import type { SMEvent } from '../world'

export type TerminalSpec = NonNullable<SMEvent['terminal']>

/** The facts this console may speak right now, given what the player holds. */
export function sayableFacts(spec: TerminalSpec, flags: ReadonlySet<string>): string[] {
  return (spec.facts ?? [])
    .filter((f) => (f.requires ?? []).every((r) => flags.has(r)))
    .map((f) => f.text)
}

/**
 * The system prompt. Persona, then only the sayable facts, then the one
 * instruction that keeps a console from being a general-purpose assistant
 * wearing a costume.
 */
export function terminalSystem(spec: TerminalSpec, flags: ReadonlySet<string>): string {
  const facts = sayableFacts(spec, flags)
  return [
    `You are a machine inside a game world. ${spec.persona}`,
    '',
    facts.length
      ? `What you know:\n${facts.map((f) => `  - ${f}`).join('\n')}`
      : 'You know nothing beyond your own function.',
    '',
    'Answer IN CHARACTER and in two sentences at most. If you are asked about something',
    'not listed above, say you have no record of it — do not invent, and do not explain',
    'that you are a language model. You are a terminal in a room.',
  ].join('\n')
}
