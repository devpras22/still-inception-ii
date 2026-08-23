/**
 * The mission compiler.
 *
 * A mission is the unit that ties quest UI, state graph, flag ledger and
 * grounding together — which means almost every rule in it is a claim about
 * GRAPH SHAPE, and a claim about graph shape can be proven with numbers instead
 * of by playing a quest to its end. That is why `compileMission` is pure and
 * why this file is long: each test isolates one rule learned the hard way and
 * encoded in `add_mission`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { missionGrounding, unwrapWorldDoc } from '../../src/world'
import { join } from 'node:path'

import { compileMission, missionProgress, MissionError, DEFAULT_PROXIMITY } from '../../src/world/mission'
import { runDoctrine } from '../../src/world/doctrine'
import { LocalWorldStore } from '../../src/world/store/local'
import { fileStore, defaultStorePath } from '../../src/world/store/file.node'
import type { SMWorld } from '../../src/world/api'

/** A one-room world to compile missions into. */
function base(subject?: string): SMWorld {
  return {
    entrance: { state: 'dock' },
    ...(subject ? { subject } : {}),
    scene: {
      states: {
        dock: {
          base: 'A rear-view shot of a diver on a stone dock over green water.',
          camera: { static: 'rear chase, eye level', dynamic: 'rear chase, drifting' },
          movement: { static: 'standing still', dynamic: 'swimming forward' },
        },
      },
      events: [],
    },
  } as unknown as SMWorld
}

test('one objective becomes one event, grounded and flagged', () => {
  const c = compileMission(base(), {
    id: 'dive', title: 'The Dive',
    objectives: [{ id: 'find_helmet', text: 'Find the brass helmet', action: 'The diver lifts the helmet from the silt.', grounded: { target: 'brass helmet' } }],
  })
  assert.equal(c.events.length, 1)
  const ev = c.events[0]!
  assert.equal(ev.name, 'Find the brass helmet', 'the objective text IS the event the player sees')
  assert.deepEqual(ev.grants, ['find_helmet'], 'the id is the flag by default')
  assert.equal(ev.oneShot, true, 'a completed objective must not keep offering itself')
  assert.equal(ev.anchor?.label, 'brass helmet', 'the target becomes the chip')
  assert.equal(ev.anchor?.minProximity, DEFAULT_PROXIMITY, 'grounded interactions demand approach')
})

test('objectives CHAIN: each one requires the last one\'s flag', () => {
  const c = compileMission(base(), {
    id: 'dive', title: 'The Dive',
    objectives: [
      { id: 'a', text: 'Open the hatch', action: 'The hatch swings wide.' },
      { id: 'b', text: 'Enter the hold', action: 'The diver slips through.' },
      { id: 'c', text: 'Take the pearl', action: 'The pearl comes free.' },
    ],
  })
  assert.deepEqual(c.events.map((e) => e.requires ?? []), [[], ['a'], ['b']])
  // The order is enforced by the ledger the player actually carries, not by a
  // separate sequencer that could disagree with the graph.
  assert.equal(c.mission.complete, 'c')
})

test('a gated objective is VISIBLE and says what unblocks it', () => {
  const c = compileMission(base(), {
    id: 'm', title: 'M',
    objectives: [
      { id: 'a', text: 'Cut the power', action: 'The lever drops.' },
      { id: 'b', text: 'Open the vault', action: 'The door swings.' },
    ],
  })
  assert.equal(c.events[1]?.lockedHint, 'Need: Cut the power', 'derived from the step that grants it')
})

test('a verified action lands in a CONSEQUENCE state, never back where it happened', () => {
  const c = compileMission(base(), {
    id: 'm', title: 'M',
    objectives: [{
      id: 'slay', text: 'Slay the eel', action: 'The blade goes in.',
      grounded: { target: 'eel', confirm: 'dead eel' },
      outcome: 'The eel lies still on the sand, the water clearing.',
    }],
  })
  const ev = c.events[0]!
  assert.equal(ev.kind, 'transition')
  assert.equal(ev.to, 'dock__slay', 'a transformation resolves into a NEW state')
  assert.equal(ev.landWhen?.label, 'dead eel', 'the confirmation is arrival evidence')
  assert.ok(c.states.some((s) => s.id === 'dock__slay'), 'and that state is created')
})

test('an in-place beat that verifies nothing is an OVERRIDE — it must not re-seed', () => {
  const c = compileMission(base(), {
    id: 'm', title: 'M',
    objectives: [
      { id: 'look', text: 'Read the plaque', action: 'The diver leans in to the lettering.' },
      { id: 'go', text: 'Swim to the wreck', location: 'wreck', base: 'A rear-view shot of a diver at a broken hull.', action: 'The wreck grows in the frame.' },
    ],
  })
  assert.equal(c.events[0]?.kind, 'override', 'no movement, no transformation, no proof → override')
  assert.equal(c.events[1]?.kind, 'transition', 'moving is a transition')
  assert.equal(c.events[1]?.to, 'wreck__go', 'the LAST objective always transforms (see the win rule)')
})

test('the FINAL objective always resolves into a terminal scene carrying the win', () => {
  const c = compileMission(base(), {
    id: 'm', title: 'The Dive',
    objectives: [
      { id: 'a', text: 'Open the hatch', action: 'It swings.' },
      { id: 'b', text: 'Take the pearl', action: 'It comes free.' },
    ],
  })
  const wins = c.endings.filter((e) => e.ending.kind === 'win')
  assert.equal(wins.length, 1)
  assert.equal(wins[0]?.id, 'dock__b', 'the win lands in a scene reached ONLY by finishing')
  assert.equal(wins[0]?.ending.title, 'MISSION COMPLETE')
  // …which is the point: a victory stamped on a re-used location fires the
  // moment the player walks back into it.
  assert.notEqual(wins[0]?.id, 'dock')
})

test('a fail branch is a sibling TRANSITION into a lose ending, never an override', () => {
  const c = compileMission(base(), {
    id: 'm', title: 'M',
    objectives: [{
      id: 'a', text: 'Loop the camera', action: 'The feed stutters and repeats.',
      fail: { name: 'Rip the drive now', action: 'The diver tears the drive free as the alarm starts.', outcome: 'Lights everywhere, and nowhere to swim.', title: 'BUSTED', subtitle: 'Too eager by half.' },
    }],
  })
  const fail = c.events.find((e) => e.name === 'Rip the drive now')
  assert.ok(fail)
  assert.equal(fail.kind, 'transition', 'an override would resurrect whoever it busted')
  assert.equal(fail.to, 'dock__fail_a')
  const lose = c.endings.find((e) => e.id === 'dock__fail_a')
  assert.equal(lose?.ending.kind, 'lose')
  assert.equal(lose?.ending.title, 'BUSTED')
})

test('a created scene RESTS by default — travel prose belongs to the dynamic layer', () => {
  // Dropping travel prose into the static layer made the character pace
  // forever after an action, which keeps the scene moving and the chips
  // un-clickable.
  const c = compileMission(base('a small brown beaver'), {
    id: 'm', title: 'M',
    objectives: [{ id: 'go', text: 'Swim to the wreck', location: 'wreck', base: 'A broken hull.', movement: 'swimming hard toward the hull' }],
  })
  const wreck = c.states.find((s) => s.id === 'wreck')?.state
  assert.match(wreck?.movement?.static ?? '', /stands completely still/)
  assert.match(wreck?.movement?.static ?? '', /small brown beaver/, 'the world SUBJECT names who is standing still')
  assert.equal(wreck?.movement?.dynamic, 'swimming hard toward the hull')
})

test('an inherited scene never smuggles a negation into prose nobody wrote', () => {
  const w = base()
  w.scene.states['dock']!.movement = { static: 'standing still, not moving at all', dynamic: 'drifting' }
  const c = compileMission(w, {
    id: 'm', title: 'M',
    objectives: [{ id: 'go', text: 'Swim on', location: 'deep', base: 'Deeper water.' }],
  })
  assert.deepEqual(c.states.find((s) => s.id === 'deep')?.state.movement, { static: '', dynamic: '' })
})

test('what it compiles PASSES the doctrine — the mission cannot author a broken world', () => {
  const w = base('a diver')
  const c = compileMission(w, {
    id: 'm', title: 'The Dive',
    objectives: [
      { id: 'a', text: 'Open the hatch', action: 'The hatch swings wide on its hinge.', grounded: { target: 'hatch' } },
      { id: 'b', text: 'Take the pearl', action: 'The pearl comes free of the shell.', grounded: { target: 'pearl', confirm: 'open shell' }, outcome: 'The shell lies open and empty on the sand.' },
    ],
  })
  // Fold the compiled output into the world and run the whole doctrine over it.
  for (const { id, state } of c.states) w.scene.states[id] = state
  for (const { id, ending } of c.endings) { const st = w.scene.states[id]; if (st) st.ending = ending }
  w.scene.events.push(...c.events)
  const errors = runDoctrine(w).filter((d) => d.severity === 'error')
  assert.deepEqual(errors.map((e) => `${e.lint} ${e.path}`), [], 'a compiled mission must be playable as authored')
})

test('missionProgress reads the SAME ledger the rail does', () => {
  const c = compileMission(base(), {
    id: 'm', title: 'M',
    objectives: [
      { id: 'a', text: 'One', action: 'x' },
      { id: 'b', text: 'Two', action: 'y' },
    ],
  })
  assert.deepEqual(missionProgress(c.mission, new Set()), { done: [false, false], activeIndex: 0, complete: false })
  assert.deepEqual(missionProgress(c.mission, new Set(['a'])), { done: [true, false], activeIndex: 1, complete: false })
  assert.deepEqual(missionProgress(c.mission, new Set(['a', 'b'])), { done: [true, true], activeIndex: -1, complete: true })
})

test('the compiler refuses what it cannot build', () => {
  assert.throws(() => compileMission(base(), { id: '', title: 'x', objectives: [{ id: 'a', text: 'a' }] }), MissionError)
  assert.throws(() => compileMission(base(), { id: 'm', title: 'M', objectives: [] }), MissionError)
  assert.throws(() => compileMission(base(), { id: 'm', title: 'M', objectives: [{ id: '', text: 'a' }] }), MissionError)
  const withMission = { ...base(), missions: [{ id: 'm', title: 'M', objectives: [] }] } as unknown as SMWorld
  assert.throws(() => compileMission(withMission, { id: 'm', title: 'M', objectives: [{ id: 'a', text: 'a' }] }), MissionError)
})

test('add_mission WRITES through the store — states, events, endings and the record', async () => {
  // A field the store drops is invisible, because the op succeeds.
  const dir = mkdtempSync(join(tmpdir(), 'studio-mission-'))
  try {
    const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
    const created = await store.createWorld({ premise: 'a diver on a stone dock' })
    const id = created.worldId!
    const rev = (await store.getScene(id)).rev
    await store.applyOps(id, [{
      op: 'add_mission', id: 'dive', title: 'The Dive',
      objectives: [
        { id: 'a', text: 'Open the hatch', action: 'The hatch swings wide.', grounded: { target: 'hatch' } },
        { id: 'b', text: 'Take the pearl', action: 'The pearl comes free.', outcome: 'The shell lies open.' },
      ],
    }] as never, rev)

    const scene = await store.getScene(id)
    assert.equal(scene.events.length, 2, 'both objectives became events')
    assert.equal(scene.events[0]?.anchor?.label, 'hatch', 'grounding survived the write')
    assert.deepEqual(scene.events[1]?.requires, ['a'], 'the chain survived the write')
    assert.equal(scene.events[0]?.lockedHint, undefined)
    assert.ok(scene.states['opening__b'], 'the consequence state was created')
    assert.equal(scene.states['opening__b']?.ending?.kind, 'win', 'and carries the win card')

    const doc = await store.getWorld(id)
    const world = doc.world ?? doc
    assert.equal(world.missions?.[0]?.id, 'dive', 'the mission record is on the world')
    assert.equal(world.missions?.[0]?.objectives.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The probe's findings, persisted and checkable from the artifact.
//
// A mission grounded on probe-verified nouns used to be indistinguishable from
// one grounded on nouns a model invented: `verified` lived on the quest's
// return value and was thrown away. The path's entire promise is that
// difference, so the evidence has to survive the call.
test('a stored mission can answer whether its own grounding held', () => {
  const objective = (id: string, target?: string) => ({
    id, text: id, location: 'opening', action: 'x', outcome: 'y', grants: id,
    ...(target ? { grounded: { target, confirm: 'z' } } : {}),
  })

  const held = { id: 'm', title: 'M', verified: ['floodgate', 'canal wall'],
    objectives: [objective('a', 'floodgate'), objective('b', 'CANAL WALL')] }
  assert.equal(missionGrounding(held).verdict, 'held', 'case and spacing are not the test')

  const violated = { id: 'm', title: 'M', verified: ['floodgate'],
    objectives: [objective('a', 'floodgate'), objective('b', 'lantern')] }
  const bad = missionGrounding(violated)
  assert.equal(bad.verdict, 'violated')
  assert.deepEqual(bad.ungrounded, [{ objective: 'b', target: 'lantern' }],
    'and it names which objective invented which object')

  // An objective with NO grounded target is not a violation: not every step of
  // a mission has to point at a thing in the frame.
  assert.equal(missionGrounding({ id: 'm', title: 'M', verified: ['floodgate'],
    objectives: [objective('a')] }).verdict, 'held')

  // The three outcomes stay distinct. A missing field is silence — this mission
  // was not built from a probe and there is nothing to hold it to.
  assert.equal(missionGrounding({ id: 'm', title: 'M', objectives: [objective('a', 'lantern')] }).verdict, 'unprobed')
  // An EMPTY array is a probe that ran and found nothing, which is a real
  // result and refuses any grounded objective. Collapsing the two would make a
  // measurement gap look like a clean bill of health.
  assert.equal(missionGrounding({ id: 'm', title: 'M', verified: [],
    objectives: [objective('a', 'lantern')] }).verdict, 'violated')
})

// The probe's findings must survive the STORE, not just the type.
//
// This codebase's oldest learning: a field the schema carries and the store
// DROPS is invisible, because the op succeeds. `add_event` silently ate
// anchor/requires/grants/oneShot for months on exactly this shape. So the
// assertion is on what comes back out of the store, never on the op object.
test('add_mission persists the probe set through the store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-grounding-'))
  try {
    const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
    const created = await store.createWorld({ premise: 'a lock-keeper’s yard' }, 'grounding')
    const worldId = created.worldId ?? ''

    await store.applyOps(worldId, [{
      op: 'add_mission',
      id: 'find_it', title: 'Find it',
      verified: ['floodgate', 'canal wall'],
      objectives: [{
        id: 'seal_gate', text: 'Seal the gate.', location: 'opening',
        action: 'She leans on the winch.', outcome: 'The gate closes.',
        grants: 'sealed', grounded: { target: 'floodgate', confirm: 'The gate is shut.' },
      }],
    }])

    const doc = await store.getWorld(worldId)
    const world = unwrapWorldDoc(doc)
    const mission = (world.missions ?? [])[0]
    assert.ok(mission, 'the mission landed')
    assert.deepEqual(mission.verified, ['floodgate', 'canal wall'], 'the probe set survived the round trip')
    // And the artifact can now answer for itself, with no live probe.
    assert.equal(missionGrounding(mission).verdict, 'held')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
