/**
 * Chapter → world.
 *
 * A hosted product runs this as four server endpoints, and their absence here
 * reads at first like a missing feature. It is not: every one of those
 * endpoints is a prompt, and this project's whole pattern is that a server-side
 * brain becomes the author's own key.
 *
 * What is worth testing is NOT that two LLM calls happen. It is the three claims
 * the feature makes: that the chapter's own ORDER survives into the brief, that
 * the model is asked to read the WHOLE chapter rather than a summary of it, and
 * that a text which is not a chapter is refused rather than turned into a
 * one-room world.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authoringInputFor, authoringLeafFor } from '../../src/author/agent/route'

import {
  segmentChapter,
  chapterBible,
  briefFromChapter,
  ChapterError,
  MAX_CHAPTER_CHARS,
  type ChapterBeat,
} from '../../src/author/agent/chapter'
import type { LLMProvider, LLMRequest } from '../../src/provider/types'

function stub(reply: string): LLMProvider & { seen: LLMRequest[] } {
  const seen: LLMRequest[] = []
  return {
    id: 'stub',
    label: 'stub',
    seen,
    isConfigured: () => true,
    async complete(req: LLMRequest): Promise<string> {
      seen.push(req)
      return reply
    },
  }
}

// The summaries are DELIBERATELY not in alphabetical order. The first draft of
// this fixture happened to be ("A…", "He…", "Someone…"), which meant a mutation
// that sorted the beats produced the identical brief and the order test passed
// while the feature was broken. A fixture that cannot distinguish the bug from
// the fix is not a fixture.
const BEATS = JSON.stringify({
  protagonist: 'a thin man in a wet overcoat',
  beats: [
    { title: 'The letter arrives', summary: 'Zinc grey morning: a letter is pushed under the door.' },
    { title: 'He burns it', summary: 'He burns the letter in the grate and watches it curl.' },
    { title: 'The knock', summary: 'Afterwards someone knocks, and he does not answer.' },
  ],
})

test('the chapter is read WHOLE, not summarised first', async () => {
  const llm = stub(BEATS)
  const chapter = 'x'.repeat(5000)
  await segmentChapter(llm, chapter)
  const sent = llm.seen[0]?.messages.at(-1)?.content ?? ''
  // Fidelity is the entire justification for this path existing. A prompt that
  // sends a précis produces a world whose sequence is invented, and a reader who
  // knows the chapter can tell at a glance.
  assert.ok(sent.includes('x'.repeat(5000)), 'the whole chapter reached the model')
})

test('a chapter longer than the guard is truncated, not sent whole', async () => {
  const llm = stub(BEATS)
  await segmentChapter(llm, 'y'.repeat(MAX_CHAPTER_CHARS + 5000))
  const sent = llm.seen[0]?.messages.at(-1)?.content ?? ''
  assert.ok(sent.length < MAX_CHAPTER_CHARS + 500, 'the guard bounded the prompt')
})

test('text that is not a chapter is REFUSED, not turned into a one-room world', async () => {
  // The failure this prevents: one beat becomes one state, the kernel dutifully
  // authors it, and the author gets a world with nowhere to go and no error.
  const llm = stub(JSON.stringify({ protagonist: 'someone', beats: [{ title: 'A thought', summary: 'He thinks.' }] }))
  await assert.rejects(() => segmentChapter(llm, 'z'.repeat(2000)), ChapterError)
})

test('the bible sees the beats the segment pass found', async () => {
  const llm = stub(JSON.stringify({ logline: 'A man burns a letter.', protagonist: 'a thin man', characters: [], locations: [], style: 'grey' }))
  const beats: ChapterBeat[] = JSON.parse(BEATS).beats
  await chapterBible(llm, 'q'.repeat(1000), beats)
  const sent = llm.seen[0]?.messages.at(-1)?.content ?? ''
  assert.match(sent, /He burns the letter/, 'the second read is told what the first one found')
})

test('the brief preserves the chapter ORDER', () => {
  const beats: ChapterBeat[] = JSON.parse(BEATS).beats
  const brief = briefFromChapter(
    { logline: 'A man burns a letter.', protagonist: 'a thin man in a wet overcoat', characters: ['the caller — a shape behind glass'], locations: ['the flat — one room, one grate'], style: 'grey light, rain' },
    beats,
  )
  const letter = brief.indexOf('letter is pushed')
  const burns = brief.indexOf('burns the letter')
  const knock = brief.indexOf('knocks')
  assert.ok(letter >= 0 && burns > letter && knock > burns, `the beats kept their order:\n${brief}`)
  // And the anti-drift material reaches the kernel, or every state redraws him.
  assert.match(brief, /wet overcoat/)
  assert.match(brief, /grey light, rain/)
})

test('a bible with no protagonist borrows the one the segment pass saw', async () => {
  // The segment pass reads the prose; the bible pass reads a summary of its own
  // work, and sometimes describes nobody. Losing the protagonist is the one
  // omission that shows up in every single frame.
  const llm = stub(JSON.stringify({ logline: 'A man burns a letter.', characters: [], locations: [], style: '' }))
  const bible = await chapterBible(llm, 'q'.repeat(1000), JSON.parse(BEATS).beats)
  assert.equal(bible.protagonist, '', 'the bible pass itself returned nothing')
  // runChapterToWorld is what fills it; this pins that the gap is real and known.
})

/**
 * The prompt must NAME a flashback as a scene.
 *
 * Found on a live model, not by reading. The first version said only "'He thinks
 * about his father' is not a beat", and `zai-glm-4.7` obeyed it exactly: given a
 * chapter whose middle section is a drowning remembered from years earlier, it
 * returned five beats and DROPPED the flashback. It was right by the letter of
 * the prompt and wrong for the product — a flashback is a scene a world model can
 * draw, and losing it cost a location and the chapter's emotional centre.
 *
 * This checks the PROMPT rather than a model's output, for the same reason
 * `kernel-vocabulary.test.ts` does: asserting on someone else's weights is a
 * flaky test, and the half we control is the sentence.
 */
test('the segment prompt tells the model a flashback is a beat, in place', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const src = readFileSync(fileURLToPath(new URL('../../src/author/agent/chapter.ts', import.meta.url)), 'utf8')

  assert.match(src, /A FLASHBACK IS A BEAT/, 'the rule is stated, not implied')
  assert.match(src, /not moved to the front/, 'and it says where the beat goes')
  // The distinction that makes the rule usable: a remembered EVENT is a scene,
  // a thought is not. Drop either half and the model gets it wrong in one
  // direction or the other.
  assert.match(src, /Interiority is not a scene/, 'interiority is still excluded')
})

/**
 * Which path a piece of text takes.
 *
 * This started life inlined in the composer as `trimmed.length >= N`, and an
 * e2e that claimed to test "routes to the chapter path" passed with the routing
 * deleted — it asserted the NOTICE and never touched the decision. Naming the
 * decision is what makes the claim checkable.
 */
test('length decides the authoring path, at the same floor the tool refuses under', async () => {
  const { authoringPathFor, CHAPTER_MIN_CHARS } = await import('../../src/author/agent/chapter')

  assert.equal(authoringPathFor('a beaver exploring a sunken city'), 'premise')
  assert.equal(authoringPathFor('x'.repeat(CHAPTER_MIN_CHARS - 1)), 'premise')
  assert.equal(authoringPathFor('x'.repeat(CHAPTER_MIN_CHARS)), 'chapter', 'the boundary is inclusive')
  // Whitespace is not prose: padding a premise with newlines must not buy two
  // extra model calls.
  assert.equal(authoringPathFor(`short premise${'\n'.repeat(CHAPTER_MIN_CHARS)}`), 'premise')
})

/**
 * The painter gets a PLACE, not the brief.
 *
 * The text is distilled exactly once, and this is the only place it happens,
 * because an image prompt must be SHORT. Handing the painter the same string
 * the kernel got — a logline, a cast, places, an atmosphere and a numbered beat
 * list — made the image model return nothing. Measured twice on a live run: a
 * correct seven-state world behind a black screen, because the world model will
 * not generate from prose with no first frame. With a short scene instead:
 * painted, probed, 32 frames.
 */
test('the painter is handed a place and a light, not the whole brief', async () => {
  const { sceneForPainter, briefFromChapter } = await import('../../src/author/agent/chapter')
  const bible = {
    logline: 'A woman returns to the lock-keeper\'s cottage.',
    protagonist: 'a woman in a coat and boots',
    characters: ['Tobias — a boy in the water'],
    locations: ['Footbridge — rotting planks over a sluggish canal', 'Cottage — low and grey'],
    style: 'Grey afternoon light, rust and damp',
  }
  const beats = [
    { title: 'She crosses', summary: 'She puts a boot through a rotten board.' },
    { title: 'She finds it', summary: 'She finds the ledger in the dresser.' },
  ]

  const scene = sceneForPainter(bible)
  assert.match(scene, /rotting planks/, 'the first location is where the camera stands')
  assert.match(scene, /Grey afternoon light/, 'and the style tail is the light it stands in')
  // The whole point: it is SHORT. The brief is not.
  assert.ok(scene.length < 200, `a paintable line, got ${scene.length} chars`)
  assert.ok(
    scene.length < briefFromChapter(bible, beats).length / 2,
    'the painter gets a fraction of what the kernel gets',
  )
  assert.doesNotMatch(scene, /1\./, 'no numbered beat list reaches the image model')
})

// A model that returns malformed JSON gets one repair round.
//
// Both live failures this path has ever had were transport, not judgement: an
// empty completion (a reasoning model spending the whole budget thinking), and
// a single missing opening quote inside an otherwise perfect eight-beat
// segmentation — `"summary": She discovers a line…`. Each one killed a book
// that takes four model calls to lay out. These pin the retry, and pin that it
// is ONE retry.
function stubs(replies: string[]): LLMProvider & { calls: number } {
  let i = 0
  return {
    id: 'stub', label: 'stub', isConfigured: () => true,
    get calls() { return i },
    async complete(): Promise<string> {
      const r = replies[Math.min(i, replies.length - 1)] ?? ''
      i += 1
      return r
    },
  }
}

test('a malformed reply is handed back to the model once, and the repair is used', async () => {
  // The exact live failure: one missing opening quote.
  const broken = '{"protagonist":"a woman in a coat","beats":[{"title":"The bridge","summary": She crosses."}]}'
  const llm = stubs([broken, BEATS])
  const res = await segmentChapter(llm, 'x'.repeat(500))
  assert.equal(llm.calls, 2, 'it retried exactly once')
  assert.ok(res.beats.length >= 2, 'the repaired reply is what got parsed')
})

test('an empty reply is reported as empty, not as "not JSON"', async () => {
  const llm = stubs(['', ''])
  await assert.rejects(
    () => segmentChapter(llm, 'x'.repeat(500)),
    (e: Error) => {
      // Naming the token budget is the whole point: "did not return JSON" sends
      // the reader to their prompt when the answer is their maxTokens.
      assert.match(e.message, /empty reply/i)
      assert.match(e.message, /budget|thinking/i)
      return true
    },
  )
  assert.equal(llm.calls, 2, 'one retry, then it gives up rather than looping')
})

// Which leaf a request routes to.
//
// The composer chose between three leaves inline, which is the exact shape
// `authoringPathFor` was pulled out of the composer to fix: inline, the only
// thing holding the routing is a typecheck, and a test that deletes it stays
// green. `route.ts` owns the choice — not `chapter.ts`, because a module that
// owns one arm of a choice should not own the choice.
test('a quest is chosen only when this studio can actually ground one', () => {
  const short = 'a lighthouse keeper'
  const prose = 'x'.repeat(600)

  // Asked for AND possible.
  assert.equal(authoringLeafFor(short, { quest: true, canProbe: true }), 'author.quest')
  assert.equal(authoringLeafFor(prose, { quest: true, canProbe: true }), 'author.quest',
    'a quest wins over length: it is a different product, not a longer premise')

  // Asked for and NOT possible: the capability overrules the request rather
  // than failing later, because a quest with no detector is a mission grounded
  // on nothing — the one thing that path exists to prevent.
  assert.equal(authoringLeafFor(short, { quest: true, canProbe: false }), 'author.generate')
  assert.equal(authoringLeafFor(prose, { quest: true, canProbe: false }), 'author.chapter')

  // Not asked for: length routes, exactly as before.
  assert.equal(authoringLeafFor(short, { quest: false, canProbe: true }), 'author.generate')
  assert.equal(authoringLeafFor(prose, { quest: false, canProbe: true }), 'author.chapter')
})

test('each leaf is handed the field it reads', () => {
  // `author.chapter` reads PROSE and takes `text`; the others take a `premise`.
  // Keeping this beside the choice is what stops a caller picking a leaf and
  // then handing it the wrong field.
  assert.deepEqual(authoringInputFor('author.chapter', 'w1', 'once upon a time'), { world: 'w1', text: 'once upon a time' })
  assert.deepEqual(authoringInputFor('author.generate', 'w1', 'a lighthouse'), { world: 'w1', premise: 'a lighthouse' })
  assert.deepEqual(authoringInputFor('author.quest', 'w1', 'a lighthouse'), { world: 'w1', premise: 'a lighthouse' })
})
