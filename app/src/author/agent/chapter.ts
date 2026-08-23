/**
 * A chapter of prose becomes a world.
 *
 * There is no server here. Segmenting a chapter into beats, distilling it
 * into a world bible, and turning the pair into a graph are each just a
 * prompt, and this project's whole pattern is that a server-side brain
 * becomes the author's own key. The kernel already proved it for premise →
 * world.
 *
 * So this is two reads and a handoff:
 *
 *   SEGMENT   the chapter → its real beats, in order, plus who it follows.
 *             The point is FIDELITY: a world built from a summary invents a
 *             sequence, and a reader who knows the chapter can tell instantly.
 *   BIBLE     the chapter → logline, characters, locations, and a style tail.
 *             The characters and locations are what stop the world model
 *             redrawing the protagonist differently in every state.
 *   HANDOFF   both, composed into a brief, into `runGeneration` — the SAME
 *             kernel, with the same doctrine gate and the same self-correcting
 *             rounds. Nothing here re-implements graph authoring, so a fix to
 *             the kernel is a fix to this.
 *
 * Both reads happen on the WHOLE chapter rather than a summary of it, which is
 * what fidelity comes from.
 */
import type { LLMProvider, LLMMessage } from '../../provider'
import type { WorldStore } from '../../world'
import { extractJson, ReplyParseError } from './reply'
import { runGeneration, type GenerationResult } from './generate'
import type { ImageProvider, VisionProvider } from '../../provider'
import type { ToolOutcome } from '../../tool'

/** One thing that happens, in the order the chapter has it happening. */
export interface ChapterBeat {
  title: string
  summary: string
}

/** What the world must keep consistent across every state it draws. */
export interface ChapterBible {
  logline: string
  protagonist: string
  characters: string[]
  locations: string[]
  style: string
}

export class ChapterError extends Error {
  constructor(message: string, readonly raw?: string) {
    super(message)
    this.name = 'ChapterError'
  }
}

/**
 * Enough for a long chapter and a structured answer. The chapter itself is the
 * expensive part of the prompt, and a reasoning model bills its thinking against
 * the same budget — the kernel learned that the hard way (`EDIT_MAX_TOKENS`).
 */
export const CHAPTER_MAX_TOKENS = 8000

/** How much prose is sent. Beyond this the beats stop improving and the call
 *  starts failing. */
export const MAX_CHAPTER_CHARS = 24_000

/** Below this, text is a PREMISE and not a chapter. The composer routes on the
 *  same number this module refuses under, so no surface can offer a path the
 *  tool will reject. Roughly a long paragraph: short enough that a detailed
 *  premise still goes to the kernel, long enough that no one reaches the two
 *  extra model calls by accident. */
export const CHAPTER_MIN_CHARS = 400

/**
 * Which authoring path a piece of text wants.
 *
 * A one-line policy, exported as a function rather than inlined in the composer
 * for a specific reason: inline, the only thing holding it was a typecheck, and
 * a test that deleted the routing entirely stayed green. A decision worth making
 * is a decision worth naming.
 */
export function authoringPathFor(text: string): 'chapter' | 'premise' {
  return text.trim().length >= CHAPTER_MIN_CHARS ? 'chapter' : 'premise'
}

const SEGMENT_SYSTEM = `You read a chapter and report what HAPPENS in it, in order.

You reply with STRICT JSON and nothing else:
{"protagonist":"<who the chapter follows, as an appearance not a name>",
 "beats":[{"title":"<3-6 words>","summary":"<one sentence: what happens, and what it changes>"}]}

Rules:
- Between four and eight beats. Fewer than four is a summary, not a sequence.
- IN THE ORDER THE CHAPTER HAS THEM. Do not reorder for tidiness.
- A beat is something that HAPPENS and leaves the situation different. "He thinks
  about his father" is not a beat; "He burns the letter" is.
- A FLASHBACK IS A BEAT. If the narration moves to another time or place and
  something happens there, that is a scene and it belongs in the list, at the
  point in the chapter where it appears — not moved to the front to make the
  story chronological. Interiority is not a scene; a remembered EVENT is.
- Use only what is in the text. Do not invent an ending the chapter does not have.
- The protagonist is described by APPEARANCE, not by name: a world model draws
  what it reads, and a name draws nothing.`

const BIBLE_SYSTEM = `You read a chapter and report what must stay CONSISTENT if it were drawn.

You reply with STRICT JSON and nothing else:
{"logline":"<one sentence: who, doing what, against what>",
 "protagonist":"<appearance: what a camera would see>",
 "characters":["<name — appearance>", ...],
 "locations":["<place — what it looks like>", ...],
 "style":"<a short atmosphere tail: light, weather, palette>"}

Rules:
- Appearance, never biography. "A thin man in a wet overcoat" beats "a grieving widower".
- At most four characters and four locations, the ones actually seen.
- The style tail is reused verbatim in every state, so keep it short and visual.
- Only what the text supports.`

/**
 * Ask, and give a malformed answer exactly one chance to be an answer.
 *
 * Both live failures this path has ever had were HERE, and neither was a bad
 * idea from the model — they were bad transport:
 *
 *   · a reply of `""`, the whole completion budget spent on reasoning tokens;
 *   · `"summary": She discovers a line…` — one missing opening quote in the
 *     middle of an otherwise perfect eight-beat segmentation.
 *
 * Both threw, and a book that takes four model calls to lay out died on the
 * first. The kernel already knows the answer to this: hand the model its own
 * output back and name what was wrong with it. One retry, not a loop — a model
 * that cannot produce JSON twice is not going to on the third attempt, and this
 * is the expensive part of the prompt (the whole chapter) to be re-sending.
 */
async function ask(llm: LLMProvider, system: string, user: string, signal?: AbortSignal | undefined): Promise<unknown> {
  const messages: LLMMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
  const call = (m: LLMMessage[]): Promise<string> =>
    llm.complete({
      json: true,
      temperature: 0.2,
      maxTokens: CHAPTER_MAX_TOKENS,
      ...(signal ? { signal } : {}),
      messages: m,
    })

  const text = await call(messages)
  try {
    return extractJson(text)
  } catch (e) {
    if (!(e instanceof ReplyParseError)) throw e
    // An empty reply is not "not JSON" — it is nothing at all, and saying "the
    // model did not return JSON" sends the reader looking at their prompt when
    // the answer is their token budget.
    const why = text.trim()
      ? `${e.message} — retrying once`
      : 'the model returned an empty reply (a reasoning model can spend the whole completion budget thinking) — retrying once'
    const repaired = await call([
      ...messages,
      { role: 'assistant', content: text },
      {
        role: 'user',
        content:
          `That was not valid JSON: ${e.message}. Send the SAME answer again as strict JSON ` +
          `and nothing else — no prose, no code fence. Check every string is opened and closed.`,
      },
    ])
    try {
      return extractJson(repaired)
    } catch (again) {
      if (again instanceof ReplyParseError) throw new ChapterError(`${why}, and the retry was not JSON either.`, repaired)
      throw again
    }
  }
}

/** A narrowing guard, not a cast: this reads a language model's JSON, which is
 *  the least trustworthy input in the codebase. */
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const strList = (v: unknown, cap: number): string[] =>
  Array.isArray(v) ? v.map(str).filter(Boolean).slice(0, cap) : []

/** The chapter's beats, in the chapter's order. */
export async function segmentChapter(
  llm: LLMProvider,
  text: string,
  signal?: AbortSignal | undefined,
): Promise<{ protagonist: string; beats: ChapterBeat[] }> {
  const raw = await ask(llm, SEGMENT_SYSTEM, `Chapter:\n\n${text.slice(0, MAX_CHAPTER_CHARS)}`, signal)
  const obj: Record<string, unknown> = isRecord(raw) ? raw : {}
  const beats: ChapterBeat[] = (Array.isArray(obj['beats']) ? obj['beats'] : [])
    .map((b) => {
      const r: Record<string, unknown> = isRecord(b) ? b : {}
      return { title: str(r['title']), summary: str(r['summary']) }
    })
    .filter((b) => b.summary)
  // A single beat is a summary wearing a list's clothes, and the world built
  // from it would have nowhere to go. Refuse rather than author a slideshow.
  if (beats.length < 2) throw new ChapterError('the model found fewer than two beats in that text — is it a chapter?')
  return { protagonist: str(obj['protagonist']), beats }
}

/** What has to look the same in every state. */
export async function chapterBible(
  llm: LLMProvider,
  text: string,
  beats: ChapterBeat[],
  signal?: AbortSignal | undefined,
): Promise<ChapterBible> {
  const outline = beats.map((b, i) => `${i + 1}. ${b.title}: ${b.summary}`).join('\n')
  const raw = await ask(
    llm,
    BIBLE_SYSTEM,
    `Chapter:\n\n${text.slice(0, MAX_CHAPTER_CHARS)}\n\nIts beats:\n${outline}`,
    signal,
  )
  const obj: Record<string, unknown> = isRecord(raw) ? raw : {}
  return {
    logline: str(obj['logline']),
    protagonist: str(obj['protagonist']),
    characters: strList(obj['characters'], 4),
    locations: strList(obj['locations'], 4),
    style: str(obj['style']),
  }
}

/**
 * The one line the PAINTER gets.
 *
 * Short on purpose: an image prompt must be short. The first location is a
 * place a camera can stand in; the style tail is the light it stands in.
 */
export function sceneForPainter(bible: ChapterBible): string {
  const place = bible.locations[0] ?? bible.logline
  return [place, bible.style].map((x) => (x ?? '').trim()).filter(Boolean).join('. ')
}

/**
 * The brief the kernel is handed.
 *
 * It is deliberately a PREMISE and not a graph: the kernel already knows how to
 * build states, events, locks and endings and has a doctrine that refuses a bad
 * one. Handing it a second graph-authoring path would mean two things to fix
 * every time the doctrine changes.
 */
export function briefFromChapter(bible: ChapterBible, beats: ChapterBeat[]): string {
  const lines = [
    bible.logline || 'A chapter, played.',
    '',
    `The player follows: ${bible.protagonist || 'the chapter\'s protagonist'}.`,
  ]
  if (bible.locations.length) lines.push(`Places, in the chapter's own words: ${bible.locations.join('; ')}.`)
  if (bible.characters.length) lines.push(`Who else appears: ${bible.characters.join('; ')}.`)
  if (bible.style) lines.push(`Atmosphere to hold throughout: ${bible.style}.`)
  lines.push(
    '',
    'Follow THIS sequence of beats, in this order, one state each, and let the',
    'player choose how to move between them:',
    ...beats.map((b, i) => `${i + 1}. ${b.title || `Beat ${i + 1}`}: ${b.summary}`),
  )
  return lines.join('\n')
}

/**
 * Chapter in, world out.
 *
 * Returns the kernel's own result, so every caller already knows how to read it
 * — including the doctrine diagnostics and the round count.
 */
export async function runChapterToWorld(opts: {
  llm: LLMProvider
  store: WorldStore
  tools?: { run(path: string, input: Record<string, unknown>, o?: { origin?: 'app' | 'agent' }): Promise<ToolOutcome> } | undefined
  image?: ImageProvider | undefined
  vision?: VisionProvider | undefined
  worldId: string
  text: string
  signal?: AbortSignal | undefined
  progress?: ((note: string) => void) | undefined
}): Promise<GenerationResult & { beats: ChapterBeat[]; bible: ChapterBible }> {
  const say = opts.progress ?? ((): void => {})
  const text = opts.text.trim()
  if (text.length < CHAPTER_MIN_CHARS) {
    throw new ChapterError(`that is too short to read as a chapter (under ${CHAPTER_MIN_CHARS} characters).`)
  }

  say('Reading the chapter…')
  const { protagonist, beats } = await segmentChapter(opts.llm, text, opts.signal)

  say(`Found ${beats.length} beats. Building the bible…`)
  const bible = await chapterBible(opts.llm, text, beats, opts.signal)
  // The segment pass sees the prose first and often describes the protagonist
  // better than the bible pass, which is looking at a summary of its own work.
  if (!bible.protagonist && protagonist) bible.protagonist = protagonist

  say('Authoring the world…')
  const result = await runGeneration({
    llm: opts.llm,
    store: opts.store,
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.image ? { image: opts.image } : {}),
    ...(opts.vision ? { vision: opts.vision } : {}),
    worldId: opts.worldId,
    premise: briefFromChapter(bible, beats),
    // The painter gets a PLACE and a light — the first location's description
    // plus the style tail. The kernel still gets the whole brief: these are
    // two readers with two different needs, and the field they used to share
    // served only one.
    scene: sceneForPainter(bible),
    ...(opts.signal ? { signal: opts.signal } : {}),
    progress: opts.progress,
  })
  return { ...result, beats, bible }
}
