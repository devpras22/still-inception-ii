/**
 * The episode record and its graders — the thing that finally lets the eDSL
 * RECOGNISE offline.
 *
 * The clause semantics are the part worth pinning, because they are surprising
 * in exactly one way: the enabled clauses OR, so a spec with both
 * `minLuminance` and `maxMotion` passes on a bright frame OR a still one, not
 * both. Getting that backwards would make every authored gate stricter than
 * the runtime's, and the author would never know.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  detectPasses,
  driftNote,
  promptForBeat,
  SESSION_DRIFT,
  emptyRecord,
  framePasses,
  hitEvents,
  markTime,
  replayGate,
  specFromLandWhen,
} from '../../src/play/episode'
import type { EpisodeRecord } from '../../src/play/episode'
import { see, either, matches } from '../../src/author/edsl'
import type { SMLandWhen } from '../../src/world/api'

/** A session: dark and still, then bright and moving, then the reef appears. */
function session(): EpisodeRecord {
  const rec = emptyRecord('w_test', '2026-08-02T00:00:00.000Z')
  rec.frames.push(
    { tMs: 0, lum: 20, motion: null },
    { tMs: 300, lum: 22, motion: 2 },
    { tMs: 600, lum: 90, motion: 40 },
    { tMs: 900, lum: 95, motion: 38 },
  )
  rec.detects.push(
    { tMs: 500, label: 'reef', extents: [] },
    { tMs: 1200, label: 'reef', extents: [0.05, 0.31] },
  )
  rec.marks.push({ tMs: 0, name: 'state:opening' }, { tMs: 800, name: 'beat:enter_arch' })
  return rec
}

test('pixel clauses OR, and a first frame with no motion cannot satisfy a motion clause', () => {
  assert.equal(framePasses({ minLuminance: 70 }, { tMs: 0, lum: 90, motion: null }), true)
  assert.equal(framePasses({ minLuminance: 70 }, { tMs: 0, lum: 20, motion: null }), false)
  // A still-frame gate on the FIRST sample: motion is null, so there is nothing
  // to compare against and the gate must not land on no evidence at all.
  assert.equal(framePasses({ maxMotion: 5 }, { tMs: 0, lum: 20, motion: null }), false)
  assert.equal(framePasses({ maxMotion: 5 }, { tMs: 300, lum: 20, motion: 2 }), true)
  // OR, not AND: a bright frame passes even though it is moving fast.
  assert.equal(framePasses({ minLuminance: 70, maxMotion: 5 }, { tMs: 600, lum: 90, motion: 40 }), true)
  assert.equal(framePasses({}, { tMs: 0, lum: 255, motion: 0 }), false, 'an empty spec never fires')
})

test('a label clause needs the label AND an instance big enough', () => {
  const d = { tMs: 0, label: 'reef', extents: [0.05, 0.31] }
  assert.equal(detectPasses({ label: 'reef' }, d), true)
  assert.equal(detectPasses({ label: 'reef', minExtent: 0.3 }, d), true, 'the biggest instance counts')
  assert.equal(detectPasses({ label: 'reef', minExtent: 0.4 }, d), false)
  assert.equal(detectPasses({ label: 'coral' }, d), false)
  assert.equal(detectPasses({ label: 'coral', aliases: ['reef'] }, d), true)
  assert.equal(detectPasses({ label: 'reef' }, { tMs: 0, label: 'reef', extents: [] }), false, 'asked and found nothing')
  assert.equal(detectPasses({ minExtent: 0.1 }, d), false, 'no label, no label clause')
})

test('hits come back in time order across BOTH channels', () => {
  const rec = session()
  assert.deepEqual(hitEvents(rec, { minLuminance: 70, label: 'reef', minExtent: 0.3 }), [600, 900, 1200])
  assert.deepEqual(hitEvents(rec, { minLuminance: 70 }, 700), [900], 'and fromMs is honoured')
  assert.equal(markTime(rec, 'beat:enter_arch'), 800)
  assert.equal(markTime(rec, 'beat:never'), null)
})

test('replaying an authored gate answers WHEN, and respects its own hits budget', () => {
  const rec = session()
  const bright: SMLandWhen = { minLuminance: 70, hits: 1 }
  const twice: SMLandWhen = { minLuminance: 70, hits: 2 }
  const thrice: SMLandWhen = { minLuminance: 70, hits: 3 }

  assert.deepEqual(replayGate(bright, rec).firedAtMs, 600)
  assert.deepEqual(replayGate(twice, rec).firedAtMs, 900, 'the second hit is when it lands')
  assert.equal(replayGate(thrice, rec).passed, false, 'a three-tick gate is not satisfied by two')

  // A gate with no clauses is not "always true" — it is ungroundable, and the
  // difference matters to an author reading a green tick.
  const empty = replayGate({ hits: 1 } as SMLandWhen, rec)
  assert.equal(empty.groundable, false)
  assert.equal(empty.passed, false)

  // The budget fields are not evidence.
  assert.deepEqual(specFromLandWhen({ minLuminance: 70, hits: 3, timeoutMs: 9000, auto: true }), { minLuminance: 70 })
})

test('a gate mark moves the clock to where the LIVE gate started counting', () => {
  // Measured on a live session: the replay reported a gate firing at 7.8s while
  // the live gate had not begun watching — it was still streaming the event's
  // phases. Both were right about WHETHER the gate can be satisfied here, and
  // neither was talking about the same clock. The player now writes a
  // `gate:<event>` mark when the arrival wait begins, so the two agree.
  const rec = session()
  rec.marks.push({ tMs: 700, name: 'gate:enter_arch' })

  // From state entry, the bright frames at 600/900 both count.
  assert.deepEqual(replayGate({ minLuminance: 70, hits: 2 }, rec, markTime(rec, 'state:opening') ?? 0).firedAtMs, 900)
  // From where the live gate actually started, only the 900 frame is inside the
  // window — so a two-hit gate has NOT been satisfied yet.
  assert.equal(replayGate({ minLuminance: 70, hits: 2 }, rec, markTime(rec, 'gate:enter_arch') ?? 0).passed, false)
  assert.equal(replayGate({ minLuminance: 70, hits: 1 }, rec, markTime(rec, 'gate:enter_arch') ?? 0).firedAtMs, 900)
})

test('THE eDSL RECOGNISES: the same value that compiles a gate replays it', async () => {
  // `.toLandWhen()` for the runtime and `.toEvidenceSpec()` for the record come
  // from the same authored value, so the two can never disagree. One value,
  // two directions, the same clause set by construction.
  const rec = session()
  const zone = see.bright(70).hits(2)
  assert.deepEqual(zone.toLandWhen(), { minLuminance: 70, hits: 2 })
  assert.deepEqual(zone.toEvidenceSpec(), { minLuminance: 70 }, 'hits is not part of the evidence')

  const m = matches(zone, rec)
  assert.equal(m.passed, true)
  assert.deepEqual(m.hits, [600, 900])

  // …and the same authored value, replayed from LATER in the session, fails —
  // which is the whole point of asking "from when".
  assert.equal(matches(zone, rec, 700).passed, false, 'only one bright frame after 700ms')

  // An either() merge recognises on either clause.
  const reefOrBright = either(see.a('reef').within(1), see.bright(70))
  assert.ok(matches(reefOrBright, rec).hits.includes(1200), 'the detect hit counts')
  assert.ok(matches(reefOrBright, rec).hits.includes(600), 'and so does the bright frame')
})

// A drifting session should say it is drifting.
//
// The picture degrades on frame count alone — measured with NOT ONE beat fired,
// the saturated fraction nearly doubles by ~400 frames and the edges go
// electric blue. Before this the studio printed a frame count and nothing else,
// so a player watching the world turn blue could not tell an ageing session
// from a badly authored world. A fresh session re-seeded at every act boundary
// resets world-model drift — call it the chapter seam; this at least names it.
test('a long session says the picture is drifting, and a fresh one stays quiet', () => {
  assert.equal(driftNote(0), null, 'a new session says nothing')
  assert.equal(driftNote(SESSION_DRIFT.visibleByFrames - 1), null, 'and stays quiet right up to the measurement')
  assert.match(driftNote(SESSION_DRIFT.visibleByFrames) ?? '', /drifts/, 'at the measured point it speaks')
  assert.match(driftNote(5000) ?? '', /fresh one/, 'and says what to do about it')
})

// The constants are a RECORD of a measurement, so they must stay orderable:
// drifted is worse than fresh, or the numbers have been swapped.
test('the drift measurement stays the right way round', () => {
  assert.ok(SESSION_DRIFT.driftedHotFraction > SESSION_DRIFT.freshHotFraction)
  assert.ok(SESSION_DRIFT.visibleByFrames > 100, 'and it is a slope over hundreds of frames, not a cliff at ten')
})

// The prompt an author is SHOWN must be the prompt that is sent.
//
// `promptForBeat` is base + camera + movement, and `readOpening` streams the
// entrance's base alone — nothing on any path sends a state's `ambient`. The
// play inspector nonetheless folded ambient into the assembled prompt and
// counted it against the budget, so the one panel that answers "what does the
// model receive" answered wrongly, and in the direction that hides a missing
// feature. This pins the assembler's actual shape so the panel cannot drift
// back: if ambient ever IS sent, this test fails and the panel is revisited.
test('the assembled prompt is base, camera and movement — ambient is not sent', () => {
  const text = promptForBeat({
    text: 'A rear view of a woman at the kerb.',
    camera: 'eye level, still',
    movement: 'she waits',
  })
  assert.equal(text, 'A rear view of a woman at the kerb. eye level, still she waits')

  // Narration is the author's line to the PLAYER, not to the model, and has
  // never ridden the prompt either.
  const withNarration = promptForBeat({
    text: 'A kerb.', camera: 'c', movement: 'm', narration: 'She hesitates.',
  })
  assert.ok(!withNarration.includes('She hesitates.'), 'narration stays out of the model prompt')
})
