/**
 * A whole book becomes a macro-graph.
 *
 * `chapter.ts` turns one chapter into one world. A BOOK is not more chapters —
 * it is chapters plus the shape between them, which is what this codebase
 * calls the spine. This codebase already has the engine that plays such a
 * graph: `world/campaign.ts` carries the four edge kinds, `resolveEdge`'s
 * selection order, `carryFlagsThrough`, and six lints that run before a
 * campaign opens. What it never had was a way to WRITE one from prose.
 *
 * So this stage produces a PLAN and stops there. Acts have no `worldId` yet,
 * because a world does not exist until the kernel authors it — and the campaign
 * type is right to demand a world it can open. Planning and authoring are
 * separate for the same reason segment and bible are: each is a different
 * question, and one failing should not cost the other.
 *
 * The golden thread is the faithful reading: the acts, in the book's order, that
 * a reader who knows it would recognise. Everything else is the failure space —
 * the choices the author did not take, which is what makes it a game rather than
 * a recital.
 */
import type { LLMProvider } from '../../provider'
import type { CampaignEdge } from '../../world'
import { extractJson, ReplyParseError } from './reply'
import type { ChapterBeat, ChapterBible } from './chapter'

/** One act, before a world exists for it. */
export interface ActPlan {
  actId: string
  title: string
  /** On the faithful spine, or a branch the book did not take? */
  canonical: boolean
  summary: string
  /** Where it happens. Short: this is what the painter will read. */
  setting: string
  /** What the protagonist must achieve here. Drives the act's own graph. */
  goal: string
}

export interface BookSpine {
  title: string
  logline: string
  acts: ActPlan[]
  edges: CampaignEdge[]
  /** Act ids in the book's order — the reading a reader would recognise. */
  goldenThread: string[]
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export class SpineError extends Error {}

/**
 * Narrow the `--beats` / `--bible` blobs a CLI or an agent hands in.
 *
 * The leaf used to cast them, which the conventions rightly refused: these
 * arrive as `--beats '<json>'` from a terminal or as an agent's own output, and
 * a cast would let a mistyped blob reach the prompt as `undefined` and come back
 * as a spine about nothing.
 */
export function toBeats(v: unknown): ChapterBeat[] {
  if (!Array.isArray(v)) throw new SpineError('beats must be an array of {title, summary}.')
  const out = v.map((b) => {
    const r: Record<string, unknown> = isRecord(b) ? b : {}
    return { title: str(r['title']), summary: str(r['summary']) }
  }).filter((b) => b.summary)
  if (out.length === 0) throw new SpineError('none of those beats had a summary.')
  return out
}

export function toBible(v: unknown): ChapterBible {
  const r: Record<string, unknown> = isRecord(v) ? v : {}
  const list = (x: unknown): string[] => (Array.isArray(x) ? x.map(str).filter(Boolean) : [])
  const bible = {
    logline: str(r['logline']),
    protagonist: str(r['protagonist']),
    characters: list(r['characters']),
    locations: list(r['locations']),
    style: str(r['style']),
  }
  if (!bible.logline && !bible.protagonist) {
    throw new SpineError('the bible needs at least a logline or a protagonist.')
  }
  return bible
}

/** Fewer than two acts is a chapter, and `author chapter` already does that
 *  better. */
export const MIN_ACTS = 2

const SYSTEM = `You lay out a book as a SHAPE a player can move through.

You reply with STRICT JSON and nothing else:
{"title":"<the work's title, or one that fits>",
 "logline":"<one sentence: who, doing what, against what>",
 "acts":[{"actId":"act_1","title":"<3-6 words>","canonical":true,
          "summary":"<what happens in this act>",
          "setting":"<where it happens, one short visual line>",
          "goal":"<what the protagonist must achieve here>"}],
 "goldenThread":["act_1","act_2"],
 "edges":[{"from":"act_1","to":"act_2","kind":"golden","label":"<what the player did>",
           "carryFlags":["<something the player now knows or holds>"],
           "requiresFlag":"<only offer this edge to a player holding this flag>"}]}

Rules:
- Between two and six acts. One act is a chapter, not a book.
- The GOLDEN THREAD is the book's own order: the acts a reader would recognise,
  canonical:true, listed in the order they are read.
- You may add at most two NON-canonical acts (canonical:false) for choices the
  book did not take. A story where every road is the one taken is not playable.
- An edge kind is one of, and ONLY one of:
    "golden"     the faithful next act — the book's own order
    "deviation"  a road the book did not take
    "recombine"  a deviation rejoining the thread
    "loop"       back to an earlier act, entered differently the second time
  A dead end is an edge with "to": null. There is no other kind; the runtime
  resolves these four and has no branch for anything else.
- FLAGS are the player's memory across acts, and the only thing that travels
  between worlds. "carryFlags" hands them forward; "requiresFlag" makes an edge
  eligible only to a player already holding one. Both are optional — but a
  campaign where nothing carries is four separate short stories.
- A "loop" edge MUST carry a flag, and the act it returns to MUST have another
  edge out that "requiresFlag" that same flag. That is the whole mechanism by
  which the second visit ends differently; a loop that carries nothing sends the
  player round the identical act forever and the campaign is refused for it.
- Every act except the last canonical one needs a way out. Every act you name in
  an edge must exist in "acts".
- The LAST act on the golden thread ENDS THE BOOK. Give it no outgoing "golden"
  edge at all — not one to another act, and above all not one to null. A golden
  edge that dead-ends means the story's own spine stops at a failure, and the
  campaign is refused before it opens. Finishing is a win state inside that act,
  not an edge leaving it.
- Settings are VISUAL and short. They are painted, not read.`

/** Narrowed, not asserted: an edge kind decides how the runtime hands off, and
 *  a typo would reach `resolveEdge` as a shape it has no branch for. */
// THE ENGINE'S OWN VOCABULARY, not a new one. The first draft of this prompt
// taught the model "advance/branch/end" — words `resolveEdge` has no branch for,
// which the typechecker caught before any model saw them. A stage that invents
// terms for a runtime it feeds is authoring for a product that does not exist.
const KINDS = ['golden', 'deviation', 'recombine', 'loop'] as const
const isKind = (v: string): v is CampaignEdge['kind'] => (KINDS as readonly string[]).includes(v)

/**
 * The book's shape, read off its beats.
 *
 * Repaired rather than trusted: a model that names an act in an edge and
 * forgets to define it would otherwise produce a campaign whose lints fail at
 * open time, which is a worse place to find out.
 */
export async function spineFromBook(
  llm: LLMProvider,
  beats: ChapterBeat[],
  bible: ChapterBible,
  targetActs = 4,
  signal?: AbortSignal | undefined,
): Promise<BookSpine> {
  const outline = beats.map((b, i) => `${i + 1}. ${b.title}: ${b.summary}`).join('\n')
  const text = await llm.complete({
    json: true,
    temperature: 0.3,
    maxTokens: 8000,
    ...(signal ? { signal } : {}),
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          `Aim for about ${targetActs} canonical acts.\n\n` +
          `Logline: ${bible.logline}\nProtagonist: ${bible.protagonist}\n` +
          `Places: ${bible.locations.join('; ')}\nAtmosphere: ${bible.style}\n\nBeats:\n${outline}`,
      },
    ],
  })

  let raw: unknown
  try {
    raw = extractJson(text)
  } catch (e) {
    if (e instanceof ReplyParseError) throw new SpineError(`${e.message}.`)
    throw e
  }
  const obj: Record<string, unknown> = isRecord(raw) ? raw : {}

  const acts: ActPlan[] = (Array.isArray(obj['acts']) ? obj['acts'] : [])
    .map((a, i): ActPlan => {
      const r: Record<string, unknown> = isRecord(a) ? a : {}
      return {
        actId: str(r['actId']) || `act_${i + 1}`,
        title: str(r['title']) || `Act ${i + 1}`,
        canonical: r['canonical'] !== false,
        summary: str(r['summary']),
        setting: str(r['setting']),
        goal: str(r['goal']),
      }
    })
    .filter((a) => a.summary)
  if (acts.length < MIN_ACTS) {
    throw new SpineError(`the model laid out ${acts.length} act(s); a book needs at least ${MIN_ACTS}. Use \`author chapter\` for one chapter.`)
  }

  const known = new Set(acts.map((a) => a.actId))
  // An edge to an act nobody defined is the failure `dangling-ref` would catch
  // at open time. Dropping it here means the author sees a campaign that works
  // rather than one that refuses.
  const edges: CampaignEdge[] = (Array.isArray(obj['edges']) ? obj['edges'] : [])
    .map((e): CampaignEdge | null => {
      const r: Record<string, unknown> = isRecord(e) ? e : {}
      const from = str(r['from'])
      const to = str(r['to'])
      const kind = str(r['kind'])
      if (!known.has(from)) return null
      const deadEnd = to === '' || to === 'null'
      if (!deadEnd && !known.has(to)) return null
      // Flags are the ONLY thing that crosses between acts. The first version of
      // this parser dropped them on the floor — and the prompt above never
      // offered the fields — so every machine-written campaign carried nothing,
      // and a live run's every hop reported `flags []`. Read them, or the
      // player's memory is a feature no author can reach.
      const carry = (Array.isArray(r['carryFlags']) ? r['carryFlags'] : []).map(str).filter(Boolean)
      const requires = str(r['requiresFlag'])
      return {
        from: { actId: from, state: str(r['state']) || '' },
        to: deadEnd ? null : { actId: to },
        kind: isKind(kind) ? kind : 'golden',
        ...(carry.length ? { carryFlags: carry } : {}),
        ...(requires ? { requiresFlag: requires } : {}),
        ...(str(r['label']) ? { label: str(r['label']) } : {}),
      }
    })
    .filter((e): e is CampaignEdge => e !== null)

  const canonical = acts.filter((a) => a.canonical).map((a) => a.actId)
  const thread = (Array.isArray(obj['goldenThread']) ? obj['goldenThread'] : [])
    .map(str)
    .filter((id) => known.has(id))
  // A thread that lost acts to the filter is worse than no thread: it claims a
  // faithful reading that skips part of the book.
  const goldenThread = thread.length >= canonical.length ? thread : canonical

  return {
    title: str(obj['title']) || bible.logline.slice(0, 60) || 'A book',
    logline: str(obj['logline']) || bible.logline,
    acts,
    edges,
    goldenThread,
  }
}
