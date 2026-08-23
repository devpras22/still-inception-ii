/**
 * The probe selector, pinned with hand-written box fixtures.
 *
 * `selectVerifiedObjects` (src/provider/vision/probe.ts) is pure geometry,
 * no I/O — so every behaviour here is provable with plain numbers rather
 * than a stubbed network call. Each fixture is built to make ONE step of
 * the algorithm (anchor / merge / discriminate / drop / measure) the only
 * thing that could explain the assertion, the way the file header's own
 * doc comment describes the four steps.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { area, cluster, iou, selectVerifiedObjects } from '../../src/provider/vision/probe'
import type { VerifiedObject } from '../../src/provider/vision/probe'
import type { DetectedBox } from '../../src/provider/types'

function box(xMin: number, yMin: number, xMax: number, yMax: number): DetectedBox {
  return { xMin, yMin, xMax, yMax }
}

test('iou/area primitives: identical boxes are 1.0, disjoint boxes are 0', () => {
  const a = box(0.1, 0.1, 0.5, 0.5)
  const b = box(0.6, 0.6, 0.9, 0.9)
  assert.ok(Math.abs(area(a) - 0.16) < 1e-9)
  assert.equal(iou(a, a), 1)
  assert.equal(iou(a, b), 0)
})

test('boxes that overlap above the cluster threshold collapse to one anchor', () => {
  // Two heavily-overlapping boxes (IoU ≈ 0.62, well above _CLUSTER_IOU=0.30)
  // — one region, described twice — must read as ONE cluster.
  const b1 = box(0.1, 0.1, 0.5, 0.5)
  const b2 = box(0.15, 0.15, 0.55, 0.55)
  const overlapping = cluster([b1, b2])
  assert.equal(overlapping.length, 1, 'two boxes over the threshold form a single cluster')
  assert.equal(overlapping[0]?.boxes.length, 2)

  // The same pair plus a box in an unrelated corner of the frame (IoU=0)
  // must NOT be swept into that cluster — the threshold has to actually cut.
  const stray = box(0.7, 0.7, 0.9, 0.9)
  const withStray = cluster([b1, b2, stray])
  assert.equal(withStray.length, 2, 'a box below the threshold starts its own cluster instead')
})

test('the densest cluster wins over a lone stray box', () => {
  // Three variants of the SAME object converge on one region (a dense,
  // mutually-overlapping 3-box cluster); a fourth variant returns a single
  // box far away. The anchor must come from the dense cluster, and the
  // stray must have zero influence on it.
  const b1 = box(0.05, 0.05, 0.35, 0.35)
  const b2 = box(0.06, 0.06, 0.4, 0.4) // the biggest of the three — expected anchor
  const b3 = box(0.07, 0.07, 0.34, 0.34)
  const stray = box(0.7, 0.7, 0.9, 0.9)

  const results = selectVerifiedObjects([
    {
      label: 'reactor',
      variants: [
        { label: 'v1', boxes: [b1] },
        { label: 'v2', boxes: [b2] },
        { label: 'v3', boxes: [b3] },
        { label: 'stray_variant', boxes: [stray] },
      ],
    },
  ])

  assert.equal(results.length, 1)
  const reactor = results[0]
  assert.ok(reactor)
  assert.deepEqual(reactor.anchor, b2, 'the anchor is the dense cluster’s largest box, not the stray')
  assert.equal(reactor.hits, 3, 'hits count the three boxes that agreed, not the stray')
  // The stray box never covers the real anchor (IoU=0), so its variant
  // fails the coverage floor and is neither the primary nor an alias.
  assert.notEqual(reactor.label, 'stray_variant')
  assert.ok(!reactor.aliases.includes('stray_variant'))
})

test('two candidates whose anchors coincide merge into one object with unioned aliases', () => {
  const boxX = box(0.1, 0.1, 0.5, 0.5)
  const boxX2 = box(0.1, 0.1, 0.52, 0.52) // slightly larger — becomes candidate A's anchor
  const boxX3 = box(0.1, 0.1, 0.5, 0.5) // candidate B's own box — IoU with boxX2 > 0.70

  const results = selectVerifiedObjects([
    {
      label: 'reactor_core',
      variants: [
        { label: 'core', boxes: [boxX] },
        { label: 'reactor', boxes: [boxX2] },
      ],
    },
    {
      label: 'power_unit',
      variants: [{ label: 'unit', boxes: [boxX3] }],
    },
  ])

  assert.equal(results.length, 1, 'two candidates whose anchors coincide collapse into ONE verified object')
  const merged = results[0]
  assert.ok(merged)
  assert.equal(merged.label, 'reactor', 'the best-covering variant across BOTH candidates wins as primary')
  assert.deepEqual(merged.aliases.sort(), ['core', 'unit'], 'aliases are unioned from both merged candidates, not just the survivor’s own')
  assert.equal(merged.hits, 3, 'hits pool the evidence from both merged candidates (2 + 1)')
})

/**
 * A door far from a portal, whose OWN curator proposed one clean variant
 * ("v_ok", two boxes that genuinely cluster on the portal) and one sloppy
 * variant ("v_bad") that happens to return exactly the door's box —
 * shared by both the promiscuity test and the expectedAspect test below,
 * since a collision is exactly what both are about.
 */
function doorPortalFixture(): VerifiedObject[] {
  const doorBox = box(0.05, 0.05, 0.35, 0.35)
  const portalA = box(0.6, 0.05, 0.9, 0.35)
  const portalB = box(0.61, 0.06, 0.91, 0.36)
  return selectVerifiedObjects([
    { label: 'door', variants: [{ label: 'door_label', boxes: [doorBox] }] },
    {
      label: 'portal',
      variants: [
        { label: 'v_ok', boxes: [portalA, portalB] },
        { label: 'v_bad', boxes: [doorBox] }, // lands squarely on the door's anchor
      ],
    },
  ])
}

test("a variant whose box lands on another object's anchor is rejected as promiscuous", () => {
  const results = doorPortalFixture()
  assert.equal(results.length, 2, 'both objects survive — the portal through its OTHER variant')
  const portal = results.find((r) => r.label === 'v_ok')
  assert.ok(portal, 'the portal is verified under its clean variant')
  assert.deepEqual(portal.aliases, [], 'v_bad never becomes an alias — it collided with a different object')
  assert.ok(
    !results.some((r) => r.label === 'v_bad' || r.aliases.includes('v_bad')),
    'the promiscuous variant is rejected outright, not merely demoted to an alias',
  )
})

test('an object whose ONLY variant is promiscuous is dropped entirely', () => {
  // A "reactor" with two supporting boxes: one (reactor_a) sits where a
  // rival "ghost" detection also lands — mutual collision, IoU 0.5625, well
  // inside (COLLIDE_IOU, MERGE_IOU) so it neither merges nor stays clean —
  // and one (reactor_b) that does not, so the object survives on that
  // variant alone. "ghost" has ONLY the colliding box, so it has no clean
  // variant left at all and must vanish completely.
  const reactorA = box(0.1, 0.1, 0.5, 0.5)
  const reactorB = box(0.02, 0.02, 0.42, 0.42)
  const ghostBox = box(0.2, 0.2, 0.5, 0.5) // fully inside reactorA, IoU(reactorA, ghostBox) = 0.5625

  const results = selectVerifiedObjects([
    {
      label: 'reactor',
      variants: [
        { label: 'reactor_a', boxes: [reactorA] },
        { label: 'reactor_b', boxes: [reactorB] },
      ],
    },
    { label: 'ghost', variants: [{ label: 'd_variant', boxes: [ghostBox] }] },
  ])

  assert.equal(results.length, 1, 'the promiscuous-only object is gone; its clean neighbour is not')
  assert.equal(results[0]?.label, 'reactor_b', 'the neighbour survives through its OTHER, non-colliding variant')
  assert.ok(
    !results.some((r) => r.label === 'd_variant' || r.aliases.includes('d_variant')),
    'the dropped object’s only variant never appears anywhere in the output',
  )
})

test('a thin object gets a minProximity floor; a fat one does not', () => {
  const thin = selectVerifiedObjects([
    { label: 'mast', variants: [{ label: 'mast', boxes: [box(0.4, 0.1, 0.5, 0.5)] }] }, // 0.10 wide, 0.40 tall — ratio 0.25
  ])
  const fat = selectVerifiedObjects([
    { label: 'crate', variants: [{ label: 'crate', boxes: [box(0.1, 0.1, 0.4, 0.4)] }] }, // square — ratio 1.0
  ])

  assert.equal(thin[0]?.minProximity, 0.14, 'short axis (0.10) × 1.4, floored/ceilinged into [0.07, 0.16]')
  assert.equal(fat[0]?.minProximity, undefined, 'a chunky object keeps the default proximity — no override')
})

test('expectedAspect appears only after a collision', () => {
  const results = doorPortalFixture()
  const door = results.find((r) => r.label === 'door_label')
  const portal = results.find((r) => r.label === 'v_ok')
  assert.ok(door, 'door survived')
  assert.ok(portal, 'portal survived')
  assert.equal(door.expectedAspect, undefined, 'door never collided with anything — no shape filter needed')
  assert.deepEqual(
    portal.expectedAspect,
    { min: 0.5, max: 1.9 },
    'portal collided (v_bad hit the door) — a shape filter now backs up the label too',
  )
})
