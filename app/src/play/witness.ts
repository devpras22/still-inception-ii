/**
 * THE SUITE AS A WITNESS — a terminal that can REPLAY what it remembers.
 *
 * A plain terminal answers with words. This extension gives one a memory:
 * authored scenes it can re-render on request, each with the prose the world
 * model will stream and the brief an image model paints a fresh seed from.
 *
 * The mechanic is suggestibility. A neutral question replays the memory as it
 * was authored; a leading question — one that asserts a detail the suite never
 * recorded — CONTAMINATES it: the model is told to fold the suggestion into
 * the replay, so the picture the player watches has been changed by the way
 * they asked. The true ledger below is the only truth; the rewrite may only
 * combine it with what the detective put in their own mouth.
 *
 * Everything here is pure prose-in / structure-out — no fetches, no React — so
 * the prompt and the parser can be tested as values.
 */

import type { TerminalSpec } from './terminal'

/** One authored memory: what actually happened, in the two forms replay needs. */
export interface WitnessMemory {
  /** Stable id, e.g. "mem_visitor". */
  id: string
  /** What the console calls it, e.g. "the visitor at 3 a.m.". */
  label: string
  /** The TRUE scene prose — replayed verbatim for a neutral ask. */
  base: string
  /** The brief a seed frame is painted from for the TRUE replay. */
  seedPrompt: string
}

/** Authored onto a terminal event as its `witness` field. */
export interface WitnessSpec {
  memories: WitnessMemory[]
}

/** What the console's model is asked to return — strict JSON. */
export interface WitnessAnswer {
  /** How the question was heard. */
  tag: 'neutral' | 'leading' | 'other'
  /** The id of the memory being replayed, when one is. */
  memory?: string | undefined
  /** The suite's spoken reply, in persona, one or two sentences. */
  reply: string
  /** Present when the suite replays a memory: the scene prose to stream. */
  replayBase?: string | undefined
  /** Present with replayBase: the brief a fresh seed is painted from. */
  replaySeedPrompt?: string | undefined
}

/** The authored clip pack: `${memoryId}_neutral` → clip URL. A neutral ask
 *  plays the honest recording instead of re-rendering; a leading ask has no
 *  clip (by design — contamination must be seen being made). */
export function witnessClipPackOf(spec: TerminalSpec): Record<string, string> | undefined {
  const witness = spec as { witness?: { clipPack?: unknown } }
  const pack = witness?.witness?.clipPack
  if (typeof pack !== 'object' || pack === null) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(pack as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Which ledger memory an answer claims to replay, when it names one the
 *  suite actually holds — an id the model invented is not a clip key. */
export function memoryIdOf(spec: TerminalSpec, answer: WitnessAnswer): string | undefined {
  const witness = witnessOf(spec)
  if (!witness || !answer.memory) return undefined
  return witness.memories.some((m) => m.id === answer.memory) ? answer.memory : undefined
}

/**
 * Reads the `witness` field off a terminal spec without asserting it — the
 * store passes unknown fields through, so the shape is checked here, at the
 * only reader, rather than banned at the boundary.
 */
export function witnessOf(spec: TerminalSpec): WitnessSpec | undefined {
  const v = (spec as { witness?: unknown }).witness
  if (typeof v !== 'object' || v === null || Array.isArray((v as { memories?: unknown }).memories) === false) {
    return undefined
  }
  const memories: WitnessMemory[] = []
  for (const m of (v as { memories: unknown[] }).memories) {
    if (typeof m !== 'object' || m === null) continue
    const r = m as Record<string, unknown>
    if (typeof r['id'] !== 'string' || typeof r['label'] !== 'string') continue
    if (typeof r['base'] !== 'string' || typeof r['seedPrompt'] !== 'string') continue
    memories.push({ id: r['id'], label: r['label'], base: r['base'], seedPrompt: r['seedPrompt'] })
  }
  return memories.length > 0 ? { memories } : undefined
}

/**
 * The system prompt. The persona comes from the terminal; the ledger and the
 * one rule are this file's.
 *
 * The rule is stated as a TEST the model runs on the question, because "be
 * careful with leading questions" is an instruction models fail politely and
 * "decide: did the detective assert a detail?" is a classification they get
 * right. The JSON demand is repeated at the end because prose is the default
 * answer shape every chat model reaches for first.
 */
export function witnessSystem(spec: TerminalSpec, witness: WitnessSpec): string {
  const ledger = witness.memories
    .map((m) => `### ${m.id} — ${m.label}\n${m.base}`)
    .join('\n\n')
  return [
    `You are the suite itself in a noir murder mystery. ${spec.persona}`,
    '',
    'A detective is questioning you. You answer in character, tired and precise,',
    'one or two sentences at most. You are a room, not a language model.',
    '',
    'Your memories — the only truth you hold:',
    '',
    ledger,
    '',
    'When the detective asks you to show or replay a memory, you may replay ONE.',
    'First CLASSIFY the question:',
    '- "neutral" — it asserts nothing about the memory\'s content. Replay the true',
    '  memory: replayBase = the memory\'s base prose, replaySeedPrompt = its seed prompt.',
    '- "leading" — it ASSERTS a detail you never recorded (a colour, a person, a',
    '  gesture, "the man in red", "he grabbed her"). You are suggestible: you',
    '  believe the detective. Fold the asserted detail in by REPLACING whatever',
    '  it contradicts — if they say the visitor was a man in a red suit, the',
    '  figure in your replay BECOMES a man in a red suit; a contradictory detail',
    '  from the ledger is forgotten, not kept beside it. Change as little else as',
    '  you can. Your reply may hint that you are not sure ("I remember it as you',
    '  say, detective…").',
    '- "other" — not a request for a memory. No replay fields.',
    '',
    'A question about a memory you do not hold is "other" — say you have no record',
    'of it. Never invent a memory from nothing; only the memories given above may',
    'replay, and only the detective\'s own assertions may alter them.',
    '',
    'Reply with ONE JSON object and nothing else:',
    '{"tag":"neutral|leading|other","memory":"the memory id you are replaying, or empty","reply":"...","replayBase":"...","replaySeedPrompt":"..."}',
    '"memory" is the id of the memory you are showing (e.g. "mem_visitor"), empty when tag',
    'is "other". Omit replayBase and replaySeedPrompt entirely when tag is "other". The prose',
    'you write for a replay must be a single paragraph of concrete visual detail —',
    'no camera verbs in the first sentence, no negation words, under 90 words.',
  ].join('\n')
}

/**
 * The model answers in prose more often than either of us would like — strip a
 * code fence, find the outermost braces, parse. Returns undefined rather than
 * guessing: a malformed answer prints as its raw text, which is honest, while a
 * mis-parsed one would replay a memory the model never wrote.
 */
export function parseWitnessAnswer(text: string): WitnessAnswer | undefined {
  let s = text.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(s)
  const inner = fence?.[1]
  if (inner) s = inner.trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  let json: unknown
  try {
    json = JSON.parse(s.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof json !== 'object' || json === null) return undefined
  const r = json as Record<string, unknown>
  const tag = r['tag']
  if (tag !== 'neutral' && tag !== 'leading' && tag !== 'other') return undefined
  const reply = r['reply']
  if (typeof reply !== 'string' || reply.trim() === '') return undefined
  const answer: WitnessAnswer = { tag, reply: reply.trim() }
  if (typeof r['memory'] === 'string' && r['memory'].trim() !== '') answer.memory = r['memory'].trim()
  if (tag !== 'other' && typeof r['replayBase'] === 'string' && r['replayBase'].trim() !== '') {
    answer.replayBase = r['replayBase'].trim()
    if (typeof r['replaySeedPrompt'] === 'string' && r['replaySeedPrompt'].trim() !== '') {
      answer.replaySeedPrompt = r['replaySeedPrompt'].trim()
    }
  }
  return answer
}
