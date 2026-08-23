/**
 * Arrival evidence, pinned by arithmetic.
 *
 * `src/play/evidence.ts` is what makes `landWhen` more than a field in a type:
 * without it the three doctrine rules that read `landWhen` would police a
 * capability nothing runs. So these tests are the proof the capability EXISTS —
 * a luminance mean over known pixels, a frame diff over two known frames, and
 * the gate logic that turns those numbers into "we have arrived".
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EVIDENCE,
  measureFrame,
  evidenceMet,
  hasPixelEvidence,
  autoEligible,
  gateBudget,
  describeGate,
  MOTION_OBSERVED,
} from '../../src/play/evidence'

/** An RGBA buffer of `n` pixels, every channel at `v`. */
function flat(n: number, v: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < n; i += 1) {
    out[i * 4] = v
    out[i * 4 + 1] = v
    out[i * 4 + 2] = v
    out[i * 4 + 3] = 255
  }
  return out
}

test('luminance is the picture, in one number', () => {
  assert.equal(Math.round(measureFrame(flat(64, 0)).luminance), 0)
  assert.equal(Math.round(measureFrame(flat(64, 255)).luminance), 255)
  assert.equal(Math.round(measureFrame(flat(64, 120)).luminance), 120)
})

test('motion is null on the FIRST sample, not zero', () => {
  // Zero would read as "the scene came to rest" and land a maxMotion gate on
  // no evidence whatsoever — an arrival declared before anything was watched.
  const first = measureFrame(flat(64, 100))
  assert.equal(first.motion, null)
  const second = measureFrame(flat(64, 100), first.luma)
  assert.equal(second.motion, 0, 'two identical frames really are still')
  const moved = measureFrame(flat(64, 140), first.luma)
  assert.equal(Math.round(moved.motion ?? -1), 40)
})

test('any satisfied signal counts as evidence', () => {
  const sample = { luminance: 95, motion: 3 }
  assert.equal(evidenceMet({ minLuminance: 90 }, sample), true, 'bright enough')
  assert.equal(evidenceMet({ minLuminance: 120 }, sample), false)
  assert.equal(evidenceMet({ maxLuminance: 30 }, sample), false)
  assert.equal(evidenceMet({ maxMotion: 4 }, sample), true, 'come to rest')
  assert.equal(evidenceMet({ minMotion: 10 }, sample), false)
  // Either passing is a hit, even when the other fails.
  assert.equal(evidenceMet({ minLuminance: 120, maxMotion: 4 }, sample), true)
  // Nothing declared is a gate that can never open.
  assert.equal(evidenceMet({}, sample), false)
})

test('motion gates need a motion reading to gate on', () => {
  const first = { luminance: 100, motion: null }
  assert.equal(evidenceMet({ maxMotion: 4 }, first), false, 'no reading yet, no arrival')
  assert.equal(evidenceMet({ minMotion: 1 }, first), false)
})

test('a label counts only when it FILLS enough of the frame', () => {
  const sample = { luminance: 100, motion: 2, labelExtent: 0.1 }
  assert.equal(evidenceMet({ label: 'door', minExtent: 0.15 }, sample), false, 'a sliver is not an arrival')
  assert.equal(evidenceMet({ label: 'door', minExtent: 0.05 }, sample), true)
  // No minExtent means any hit counts — which is exactly what the
  // `sliver-evidence` lint warns about at authoring time.
  assert.equal(evidenceMet({ label: 'door' }, sample), true)
  // …and a label that was never found is not evidence at all.
  assert.equal(evidenceMet({ label: 'door', minExtent: 0.05 }, { luminance: 100, motion: 2 }), false)
})

test('auto is honoured for the FREE signals only', () => {
  // The runtime rule the `auto-needs-pixels` lint enforces at authoring time.
  assert.equal(autoEligible({ minLuminance: 90, auto: true }), true)
  assert.equal(autoEligible({ maxMotion: 4, auto: true }), true)
  assert.equal(autoEligible({ label: 'door', auto: true }), false, 'a visible road is not driving')
  assert.equal(autoEligible({ minLuminance: 90 }), false, 'not a zone without auto')
  assert.equal(hasPixelEvidence({ label: 'door' }), false)
})

test('the gate fails OPEN, and never on a nonsense budget', () => {
  assert.deepEqual(gateBudget({}), { hits: EVIDENCE.hits, timeoutMs: EVIDENCE.timeoutMs })
  assert.equal(gateBudget({ hits: 3 }).hits, 3)
  // A zero or negative budget would trap a player mid-event forever, or land
  // instantly on no evidence — both are floors, not author choices.
  assert.equal(gateBudget({ hits: 0 }).hits, 1)
  assert.equal(gateBudget({ timeoutMs: 10 }).timeoutMs, 1000)
})

// A gate that failed must say what IT wanted.
//
// "the arrival evidence never appeared within its timeout" is true of every
// gate and actionable for none — it does not distinguish a world that was meant
// to SHOW something from one that was meant to hold STILL. The one authored
// gate this project has recorded on camera was `{maxMotion: 4}`, and its
// timeout message told the author nothing about the number they had written.
test('a failed gate is described in the terms the author wrote it in', () => {
  assert.match(describeGate({ label: 'a rusted winch' }), /never showed "a rusted winch"/)

  const still = describeGate({ maxMotion: 4 })
  assert.match(still, /never came to rest/)
  assert.match(still, /4/, 'the threshold the author chose')
  // The measured idle floor belongs in the message: without it "motion at or
  // under 4" reads as a small number, when 4 is roughly where a live world
  // model already sits when nothing is happening.
  assert.match(still, /idles around/)

  assert.match(describeGate({ minMotion: 9 }), /never moved enough/)
  // Both halves of a two-sided gate get said, not just the first.
  const both = describeGate({ label: 'a door', maxMotion: 3 })
  assert.match(both, /a door/)
  assert.match(both, /came to rest/)
})

// The kernel's example stillness threshold must be REACHABLE.
//
// It shipped as `maxMotion: 4`, which reads like "almost no movement" and is
// the idle floor of a live world model — measured median 3.93 at rest. But a
// gate is judged while the scene REGENERATES toward its destination, where the
// median is 24.34 and not one tick in 28 came in at or under 4. So every gate
// authored from that example burned its full 20s timeout and landed unverified.
// This pins the relationship the number has to the measurements, so a future
// edit to either has to face the other.
test('the settled ceiling sits above idle and well below a transition', () => {
  assert.ok(MOTION_OBSERVED.settledCeiling > MOTION_OBSERVED.max,
    'reachable: above every idle tick ever sampled, so a settled scene can satisfy it')
  assert.ok(MOTION_OBSERVED.settledCeiling < MOTION_OBSERVED.duringTransition / 2,
    'meaningful: far enough below a regenerating scene that it still discriminates')
  assert.ok(MOTION_OBSERVED.atRestAbout < MOTION_OBSERVED.settledCeiling,
    'and the idle floor is not itself the ceiling')
})
