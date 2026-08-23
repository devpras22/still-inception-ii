/**
 * The starter world, authored as a PROGRAM.
 *
 * This is the language's acceptance oracle, and it is deliberately the world
 * the studio already ships: `tests/unit/edsl.test.ts` compiles this file and
 * asserts it is DEEP-EQUAL to `starterWorld()` in `src/world/store/local.ts`.
 * That is the standard worth holding an eDSL to, for two reasons — a language
 * that cannot express the world you actually ship is not a language, and a
 * compiler that changes that world's bytes is a liability.
 *
 * Read it as a tour of the layers:
 *   · fragments compose prose that is written across several readable lines and
 *     compiles to exactly the single line the store holds (the whitespace law);
 *   · `see.still(12).within(5000)` is the arrival evidence, an algebra rather
 *     than a bag of numbers;
 *   · `.compile()` runs the whole doctrine and would THROW here rather than let
 *     a rule-breaking world reach the store.
 */
import { world, frag, see } from '../src/author/edsl'

/** Written once, used everywhere it belongs — the repetition a language kills. */
const POPLARS = frag`a line of poplars on the left`

export const program = world('walk_to_the_bench', {
  name: 'A Walk to the Bench',
  description:
    'Three states, two ways forward and a place to stop — the smallest complete world, here to be taken apart.',
  entrance: { state: 'lane' },
})
  .state('lane', {
    base: frag`A narrow dirt lane between low stone walls, late afternoon. Deep ruts
      hold rainwater. Long shadows fall across the track from ${POPLARS}.`,
    camera: { static: 'eye level, walking height, lane centred', dynamic: 'slow forward drift' },
    movement: { static: 'standing still on the track', dynamic: 'grass heads moving at the wall base' },
    ambient: ['dust in low sun', 'a loose gate somewhere ahead'],
  })
  .state('orchard_gate', {
    base: frag`A wooden gate standing open in a gap in the stone wall. Beyond it,
      rows of old apple trees on unmown grass, fruit still on the branches.`,
    camera: { static: 'eye level, framed square on the open gate', dynamic: 'slight push toward the gap' },
    movement: { static: 'stopped at the threshold', dynamic: 'branches shifting, one apple falling' },
    ambient: ['flies in the sun', 'grass to the knee'],
  })
  .state('bench_under_trees', {
    base: frag`A weathered wooden bench under two apple trees, seen from a few steps
      away. Bright patches of low sun on the seat through the leaves.`,
    camera: { static: 'eye level, bench centre frame', dynamic: 'settling to a stop' },
    movement: { static: 'seated, hands on knees', dynamic: 'leaf shadows moving over the slats' },
    ending: { kind: 'win', title: 'You sat down.', subtitle: 'Nothing else needed doing.' },
  })
  .event('walk_up_the_lane', {
    kind: 'transition',
    from: ['lane'],
    to: 'orchard_gate',
    base: 'Walking on up the rutted lane until the gap in the wall comes level.',
    detail:
      'The poplar shadows pass over the frame one at a time; the open gate swings into view on the right.',
    // Not 'w': a drive key belongs to the player's hands, and an authored
    // hotkey may not take one (the editor bounces these now).
    hotkey: 'k',
    // Two beats, each with its OWN camera — `shared-phase-camera` would fire on
    // a second beat that leaned on a shared one, and would fire at COMPILE
    // time, which is the point.
    phases: [
      {
        base: 'The rutted lane passing underfoot, poplar shadows crossing the frame one at a time.',
        camera: 'low, tilted down at the track ahead',
        minMs: 1200,
      },
      {
        base: 'The stone wall coming level, the gap in it widening to fill the way ahead.',
        camera: 'eye level, the gap centred and growing',
        minMs: 1200,
      },
    ],
    anchor: { label: 'the gap in the wall', aliases: ['gate', 'gap', 'opening'], minProximity: 0.18 },
  })
  .event('go_to_the_bench', {
    kind: 'transition',
    from: ['orchard_gate'],
    to: 'bench_under_trees',
    base: 'Stepping through the gate and crossing the long grass to the bench.',
    detail: 'Grass drags at the shins; the bench comes up centre frame and the camera settles.',
    hotkey: 'e',
    // The arrival, as an algebra: the scene coming to REST is the physical
    // signature of having got there.
    until: see.still(12).hits(1).within(5000),
    // No minProximity, on purpose: this is the `sliver-evidence` warning the
    // shipped world carries so the rule and its one-click fix are visible on
    // the first world anyone opens. A WARNING rides along; it does not block.
    anchor: { label: 'the bench', aliases: ['seat', 'bench under the trees'] },
  })
  .event('listen', {
    kind: 'override',
    from: ['lane', 'orchard_gate'],
    base: 'The wind comes up: every leaf and grass head leans the same way, then falls back.',
    detail:
      'The frame holds exactly where it is, steady on the same view, while light flickers through moving leaves.',
    hotkey: 'l',
  })
