/**
 * A book becomes a campaign: several worlds, joined.
 *
 * The pieces existed separately and nothing put them together. `chapter.ts`
 * reads prose into beats and a bible. `spine.ts` lays a book out as acts and the
 * edges between them. `world/campaign.ts` already plays such a graph, resolves
 * its edges, carries flags across acts, and refuses to open one that fails any
 * of six lints. This is the assembly, and it is deliberately
 * the dullest file of the three: read, plan, author each act, build the graph,
 * save, lint.
 *
 * ONE ACT AT A TIME, and a failure stops the run rather than saving a campaign
 * with a hole in it. A macro-graph whose third act is missing is not a partial
 * book; it is a story that ends in a wall, and the lints would refuse it at play
 * time anyway. Better to fail while the author is still watching.
 */
import type { LLMProvider, ImageProvider, VisionProvider } from '../../provider'
import type { Campaign, CampaignActRef, CampaignDiagnostic, SMWorld, WorldStore } from '../../world'
import { lintCampaign } from '../../world'
import type { ToolOutcome } from '../../tool'
import { segmentChapter, chapterBible } from './chapter'
import { spineFromBook, type ActPlan, type BookSpine } from './spine'
import { runGeneration } from './generate'

export class BookError extends Error {}

export interface BookResult {
  campaign: Campaign
  spine: BookSpine
  /** The six campaign lints, run on the finished graph. */
  diagnostics: CampaignDiagnostic[]
  /** Worlds authored, in act order. */
  worlds: { actId: string; worldId: string; states: number }[]
}

/**
 * The brief for ONE act.
 *
 * An act is not a premise and not a chapter: it is a place, a goal, and what
 * happened. The kernel gets all three; the painter gets the setting only, for
 * the reason `chapter.ts` learned the hard way — an image prompt must be short.
 */
export function briefForAct(act: ActPlan, spine: BookSpine): string {
  return [
    spine.logline,
    '',
    `This act: ${act.title}. ${act.summary}`,
    act.setting ? `Where: ${act.setting}` : '',
    act.goal ? `What the player is trying to do here: ${act.goal}` : '',
    '',
    act.canonical
      ? 'This is on the book\'s own path.'
      : 'This is a road the book did NOT take — it should feel like a real alternative, not a mistake.',
  ].filter(Boolean).join('\n')
}

/**
 * Below this, a text is a CHAPTER and not a book — one world, not several.
 *
 * Exported because the Book screen shows it and disables its button under it:
 * the composer learned the same lesson for `CHAPTER_MIN_CHARS`, that a surface
 * offering a path the tool will refuse is a promise the product cannot keep.
 * One number, read by both.
 */
export const BOOK_MIN_CHARS = 1200

export async function runBookToCampaign(opts: {
  llm: LLMProvider
  store: WorldStore
  tools?: { run(path: string, input: Record<string, unknown>, o?: { origin?: 'app' | 'agent' }): Promise<ToolOutcome> } | undefined
  image?: ImageProvider | undefined
  vision?: VisionProvider | undefined
  text: string
  targetActs?: number | undefined
  signal?: AbortSignal | undefined
  progress?: ((note: string) => void) | undefined
}): Promise<BookResult> {
  const say = opts.progress ?? ((): void => {})
  const text = opts.text.trim()
  if (text.length < BOOK_MIN_CHARS) {
    throw new BookError(`that is too short to lay out as a book (under ${BOOK_MIN_CHARS} characters). Try \`author chapter\`.`)
  }

  say('Reading the book…')
  const { protagonist, beats } = await segmentChapter(opts.llm, text, opts.signal)
  const bible = await chapterBible(opts.llm, text, beats, opts.signal)
  if (!bible.protagonist && protagonist) bible.protagonist = protagonist

  say('Laying out the acts…')
  const spine = await spineFromBook(opts.llm, beats, bible, opts.targetActs ?? 4, opts.signal)

  const worlds: BookResult['worlds'] = []
  const acts: CampaignActRef[] = []
  // The lints read the acts' GRAPHS, not just their ids — `exitStatesFor` has to
  // know which states actually hand off, so a campaign whose edge leaves from a
  // state that does not exist is caught here rather than at play time.
  const runKey = `book_${Math.random().toString(36).slice(2, 10)}`
  const authored: Record<string, SMWorld> = {}
  for (const [i, act] of spine.acts.entries()) {
    say(`Authoring act ${i + 1} of ${spine.acts.length}: ${act.title}…`)
    // The second argument is an IDEMPOTENCY KEY, not a source tag. A constant
    // here handed act 2 the world act 1 had already authored, and the kernel
    // then refused its own state ids as duplicates — a whole campaign silently
    // collapsing into a single world. One key per act, scoped to this run.
    const created = await opts.store.createWorld({ premise: act.title }, `${runKey}:${act.actId}`)
    const worldId = created.worldId ?? ''
    if (!worldId) throw new BookError(`could not create a world for act "${act.actId}".`)
    const res = await runGeneration({
      llm: opts.llm,
      store: opts.store,
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(opts.image ? { image: opts.image } : {}),
      ...(opts.vision ? { vision: opts.vision } : {}),
      worldId,
      // The kernel's own progress, ATTRIBUTED to the act it belongs to. Without
      // this a book took four minutes and printed four lines, while underneath
      // each act was painting, probing, verifying and running correction rounds
      // in silence. `chapter.ts` forwarded it and this did not — the same
      // pipeline, told two different stories depending on the door taken.
      progress: (note: string) => say(`${act.title}: ${note}`),
      premise: briefForAct(act, spine),
      // The painter gets the place and the light. Same rule as the chapter path.
      scene: [act.setting, bible.style].filter(Boolean).join('. '),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    worlds.push({ actId: act.actId, worldId, states: res.states })
    // Keyed by ACT id, not world id: `lintCampaign` looks each act's world up by
    // `worlds[act.actId]`. Keying by worldId type-checks, reads correctly, and
    // makes all six lints report "act has no world" for acts whose worlds are
    // sitting in the very map being passed — a live run reported 4 errors over 4
    // worlds that existed. A Record<string, T> will take any string you give it.
    authored[act.actId] = await opts.store.getWorld(worldId)
    acts.push({
      actId: act.actId,
      worldId,
      title: act.title,
      canonical: act.canonical,
      ...(act.summary ? { summary: act.summary } : {}),
    })
  }

  // The campaign is only assembled once every act is a world that exists. An
  // act referencing a world the store cannot open is the one failure the macro
  // engine has no answer for.
  const start = spine.goldenThread[0] ?? spine.acts[0]?.actId ?? ''
  const campaign: Campaign = {
    id: `camp_${Math.random().toString(36).slice(2, 10)}`,
    title: spine.title,
    logline: spine.logline,
    graph: { start, acts, edges: spine.edges, goldenThread: spine.goldenThread },
  }

  // Resolve every edge's EXIT STATE, which the spine could not possibly know.
  // The acts are laid out before a single one is authored, so the model naming
  // `from.state` would be naming a state that does not exist yet — it returns
  // "" and the `exit-state-exists` lint rightly refuses the campaign. The state
  // an act is left FROM is knowable only now: prefer where the act ends (a win
  // ending is the door to the next act), else the last state authored.
  for (const e of campaign.graph.edges) {
    if (e.from.state) continue
    const world = authored[e.from.actId]
    if (!world) continue
    const states = Object.entries(world.scene?.states ?? {})
    const win = states.find(([, st]) => (st as { ending?: { kind?: string } }).ending?.kind === 'win')
    const exit = win?.[0] ?? states[states.length - 1]?.[0]
    if (exit) e.from.state = exit
  }

  say('Checking the story…')
  const saved = await opts.store.saveCampaign(campaign)
  // Linted HERE rather than left for the player: the six rules run before a
  // campaign opens anyway, and an author who is still looking at the screen can
  // do something about a dead end. One who pressed Play cannot.
  const diagnostics = lintCampaign(campaign.graph, authored)
  return { campaign: saved, spine, diagnostics, worlds }
}
