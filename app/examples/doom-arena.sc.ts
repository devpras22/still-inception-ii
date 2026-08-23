/**
 * A world for a model that only understands MOVEMENT.
 *
 * `examples/world-doom.py` declares `promptableEvents: false`, and that single
 * flag decides everything about how this world is written. The model takes one
 * discrete action per frame and no prose at all, so an authored beat cannot
 * change the picture. A world built the usual way — prose beats driving the
 * scene from state to state — would appear to work in the editor and do
 * strictly nothing on screen.
 *
 * WHAT STILL WORKS, and it is most of the studio: the graph, the transitions,
 * flags, the ending, the quest rail and the chips are all the studio's own
 * layer. They run over the picture rather than through the model. So the
 * division of labour here is exact:
 *
 *   the PLAYER drives          W / A / D and the arrow keys move the camera
 *   the MODEL paints           whatever the arena looks like from there
 *   the STUDIO decides         which state you are in, and when you arrived
 *
 * ARRIVAL IS MEASURED FROM PIXELS, which is the only honest option here. There
 * is no prompt to assert a change and no vision key assumed, so every landing
 * below uses a free signal — motion, or its absence. `see.moving(...)` is the
 * signature of travelling; `see.still(...)` is the signature of having stopped.
 * Both are computed from the frames the model is already sending.
 *
 * The prose is still worth writing. It is what the narration panel reads, what
 * the editor shows, and what a DIFFERENT model would be given if you pointed
 * this same world at a promptable one. It is a description of the place, and it
 * survives the swap.
 *
 *   python examples/world-doom.py            # Apple silicon: about 10 fps
 *   Settings -> World model -> ws://localhost:8765 -> Test connection -> Save
 */
import { world, frag, see } from '../src/author/edsl'

/** The arena the bridge generates is a plain room, so the prose describes a
 *  plain room. Promising a Doom level here would be promising something the
 *  generated conditioning map does not contain. */
const CONCRETE = frag`grey concrete block walls under flat overhead light`

export const program = world('doom_arena', {
  name: 'The Arena',
  description:
    'Three rooms and a door, for a world model that reads your hands and never reads your prose. ' +
    'Drive it with W, A and D; arriving is measured from the picture.',
  entrance: { state: 'hall' },
})
  .state('hall', {
    base: frag`A wide empty hall of ${CONCRETE}, seen from standing height. A dark
      opening in the far wall leads onward.`,
    camera: { static: 'eye level, centred on the far opening', dynamic: 'slow forward drift' },
    movement: { static: 'standing still on the floor', dynamic: 'the far opening growing as it nears' },
    ambient: ['flat overhead light', 'a low hum from somewhere below'],
  })
  .state('corridor', {
    base: frag`A narrow corridor of ${CONCRETE}, running straight ahead. The walls
      close in to either side and the light dims toward the far end.`,
    camera: { static: 'eye level, corridor centred and running to a vanishing point', dynamic: 'forward travel' },
    movement: { static: 'stopped between the walls', dynamic: 'wall panels sliding past on both sides' },
    ambient: ['dust in the beam of a wall lamp'],
  })
  .state('far_door', {
    base: frag`A heavy steel door at the end of the corridor, filling the view. Rust
      streaks run down from its hinges.`,
    camera: { static: 'eye level, the door square in frame', dynamic: 'coming to a stop' },
    movement: { static: 'halted a pace from the door', dynamic: 'the door filling more of the frame' },
    ending: { kind: 'win', title: 'You reached the door.', subtitle: 'You drove the whole way there yourself.' },
  })

  // TRAVELLING, not talking. This lands when the picture has been in sustained
  // motion four times inside twelve seconds — which is what driving forward
  // through a corridor looks like from the outside. A player who stands still
  // stays in the hall, correctly: the world is waiting on the pixels, and the
  // pixels are waiting on their hands.
  .event('head_for_the_opening', {
    kind: 'transition',
    from: ['hall'],
    to: 'corridor',
    base: 'Crossing the hall floor toward the dark opening in the far wall.',
    detail: 'The opening widens from a slot to a doorway as the far wall comes up.',
    hotkey: 'k',
    until: see.moving(14).hits(4).within(12000),
  })

  // ARRIVING is the mirror signal: the picture coming to REST. Driving down a
  // corridor and stopping in front of something is the one gesture this model
  // renders well, so it is the one the ending is hung on.
  .event('reach_the_door', {
    kind: 'transition',
    from: ['corridor'],
    to: 'far_door',
    base: 'Running the length of the corridor until the steel door fills the way ahead.',
    detail: 'The wall panels slide past faster, then slow, and the door settles square in frame.',
    hotkey: 'e',
    until: see.still(10).hits(1).within(15000),
  })

  // An override returns you to the state you were standing in, so it is the
  // right shape for something that changes the LIGHT rather than the place.
  // Space is the model's one non-movement action, and the flash is the only
  // part of it the picture reliably shows.
  .event('fire', {
    kind: 'override',
    from: ['hall', 'corridor'],
    base: 'A muzzle flash throws hard light up the walls for an instant, then falls away.',
    detail: 'The frame holds where it is while the light jumps once and drains back to the overheads.',
    hotkey: 'f',
  })
