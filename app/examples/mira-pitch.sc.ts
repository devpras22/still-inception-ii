/**
 * A world for MIRA Mini — car soccer, running on your own machine.
 *
 * The same constraint as `doom-arena.sc.ts` applies (`examples/world-mira.mjs`
 * also declares `promptableEvents: false`), so this world is driven, not
 * narrated. The difference is the VOCABULARY of the driving, and it changes
 * what a world can honestly ask for:
 *
 *   doom     forward, two turns, two strafes, one attack — and no reverse
 *   mira     forward AND back, two turns, two rolls, a jump, and a boost
 *
 * A car that can reverse can be asked to come back, so this graph is a LOOP
 * rather than a corridor: kickoff, the run at the ball, and a return to the
 * middle to do it again. The doom world could ask for a return trip, and the
 * player would have to turn all the way around to answer it, which is the kind
 * of thing that reads as a bug rather than a rule.
 *
 * SCORING IS THE STUDIO'S, NOT THE MODEL'S. MIRA Mini paints car soccer; it
 * keeps no score, and asking it who is winning is asking a painter for the
 * league table. The flag below (`kicked_off`) is the studio's own bookkeeping,
 * and the ending fires when the picture says the car has come to rest after a
 * run — evidence, rather than a score the model was never keeping.
 *
 *   pip install alakazam-mira-mini && mira-mini play    # or the bridge:
 *   node examples/world-mira.mjs
 *   Settings -> World model -> ws://localhost:8765 -> Test connection -> Save
 */
import { world, frag, see } from '../src/author/edsl'

/** One phrase, one place. The pitch is described once and reused, so the three
 *  states differ by what the CAMERA is doing rather than by re-describing the
 *  arena three ways and drifting each time. */
const PITCH = frag`a walled indoor pitch with a mirrored floor and bright side boards`

export const program = world('mira_pitch', {
  name: 'Kickoff',
  description:
    'Car soccer on a local world model: line up, run at the ball, come back and do it again. ' +
    'Drive with W, A, S, D; space jumps. Arriving is measured from the picture.',
  entrance: { state: 'kickoff' },
})
  .state('kickoff', {
    base: frag`A car sitting still at the centre line of ${PITCH}, the ball ahead
      of it on the spot.`,
    camera: { static: 'chase camera, low behind the car, ball centred ahead', dynamic: 'holding steady' },
    movement: { static: 'the car at rest, wheels straight', dynamic: 'a slight settle on the suspension' },
    ambient: ['reflections sliding on the polished floor', 'a crowd murmur off the boards'],
  })
  .state('the_run', {
    base: frag`The car travelling at speed across ${PITCH}, the ball rolling ahead
      of it and the far boards coming up fast.`,
    camera: { static: 'chase camera, low and close behind', dynamic: 'fast forward travel, slight yaw as it steers' },
    movement: { static: 'holding a line across the floor', dynamic: 'floor reflections streaking past underneath' },
    ambient: ['boost trail flaring behind', 'the ball skipping once on the floor'],
  })
  .state('back_to_the_middle', {
    base: frag`The car turned around and rolling back toward the centre line of
      ${PITCH}, the goal mouth receding behind it.`,
    camera: { static: 'chase camera, the centre line ahead', dynamic: 'easing to a halt on the spot' },
    movement: { static: 'stopped square on the centre line', dynamic: 'the car settling as it stops' },
    ending: {
      kind: 'win',
      title: 'Back on the spot.',
      subtitle: 'You drove out, took your run and brought it home.',
    },
  })

  // TRAVELLING. The same free signal the doom world uses, at a higher threshold:
  // a car at speed moves far more of the frame per sample than a walking camera
  // does, so the number that means "under way" is different per model even
  // though the RULE is identical. Tuning it by copying the other world's
  // constant is how a landing fires on the first twitch of the wheel.
  .event('run_at_the_ball', {
    kind: 'transition',
    from: ['kickoff'],
    to: 'the_run',
    base: 'Pulling away from the centre line and driving hard at the ball.',
    detail: 'The floor reflections stretch into streaks and the far boards swell in the frame.',
    hotkey: 'k',
    grants: ['kicked_off'],
    until: see.moving(22).hits(3).within(10000),
  })

  // ARRIVING, gated on the flag the run granted. `requires` is what makes this a
  // loop rather than a shortcut: a player who has yet to take a run has nothing
  // to come back FROM, and the studio refuses the transition rather than
  // ending a world that never really started.
  .event('bring_it_home', {
    kind: 'transition',
    from: ['the_run'],
    to: 'back_to_the_middle',
    base: 'Turning the car around and rolling back to the centre line.',
    detail: 'The goal mouth swings out of frame, the centre line comes up, and the car settles on the spot.',
    hotkey: 'e',
    requires: ['kicked_off'],
    until: see.still(14).hits(1).within(15000),
  })

  // Space is a jump in this model, which is a real move rather than a
  // decoration: it changes what the picture shows without changing where the
  // car is, so an override is exactly the right shape for it.
  .event('jump', {
    kind: 'override',
    from: ['kickoff', 'the_run'],
    base: 'The car hops, the horizon tips, and the mirrored floor swings through the frame.',
    detail: 'The chase camera rises with the car and drops back as it lands square.',
    hotkey: 'j',
  })
