/**
 * Authoring operations, as tools.
 *
 * Everything that edits a world's graph. These are the same store mutators the
 * Inspector calls, which is deliberate: a world authored from the terminal and a
 * world authored by clicking are the same world, produced by the same code,
 * validated the same way. Two authoring paths that could disagree would
 * eventually disagree.
 *
 * The revision contract: every write takes an OPTIONAL `rev`. A caller holding a
 * revision it authored against (the editor, with an open graph) passes it, and a
 * stale write fails with a 409 instead of silently clobbering an edit it never
 * saw. A caller that just wants the write to land (the terminal) omits it, and
 * the leaf reads the current revision immediately before writing. One leaf serves
 * both without making the CLI paste revisions.
 *
 * The named flags edit one field at a time; `ops` is the batch form — the store's
 * own operation vocabulary, atomic in one revision — and is how the language-model
 * agent, or any caller composing a structured change, writes a whole edit at once.
 */

import { defineTool } from '../tool/define'
import { runGeneration } from './agent/generate'
import { runChapterToWorld } from './agent/chapter'
import { spineFromBook, toBeats, toBible } from './agent/spine'
import { runBookToCampaign } from './agent/book'
import { runQuestGeneration } from './agent/quest'
import type { Program } from './edsl'
import { candidateFor } from './edsl'
import { toPublicOps } from '../world'
import type { WorldStore, NullablePatch, PublicOp, SMState, SMEvent } from '../world'

/** The revision to write against: the caller's if it supplied one, else fresh. */
async function revFor(store: WorldStore, worldId: string, given: string | undefined): Promise<string> {
  if (given !== undefined) return given
  const scene = await store.getScene(worldId)
  return scene.rev
}

const REV_PARAM = {
  type: 'string' as const,
  describe:
    'Optimistic-concurrency revision from a prior read. Pass the rev you authored against and a stale write fails with a conflict; omit it and the current revision is read immediately before writing.',
}

/** A stagecraft program, by shape. */
function isProgram(v: unknown): v is Program {
  if (typeof v !== 'object' || v === null) return false
  // `in`, not a spread copy: these are class METHODS and live on the
  // prototype, so `{ ...program }` sees none of them. That mistake made a
  // perfectly good program look like the wrong export.
  if (!('compile' in v) || !('check' in v)) return false
  return typeof v.compile === 'function' && typeof v.check === 'function'
}

export const authorTools = defineTool({
  summary: 'Author a world: add and edit its states and events, set the entrance, run the checks.',
  description:
    'The graph operations behind the editor, available headlessly. Every write is concurrency-checked against a revision — the one you pass, or the current one read immediately before the write.',
  children: {
    state: defineTool({
      summary: 'States: the prose describing what the camera sees at one point in a world.',
      description: 'A state has an id and a base prompt, and may carry an ending that finishes the world.',
      children: {
        add: defineTool({
          summary: 'Add a state to a world.',
          description:
            'The id is optional and generated from the prompt when omitted. The base prompt is what the camera sees while the world is in this state: concrete and visual, not instructions to a player.',
          kind: 'mutation',
          params: {
            world: { type: 'string', describe: 'The world id.', required: true, positional: 0 },
            base: { type: 'string', describe: 'What the camera sees in this state.', required: true },
            id: { type: 'string', describe: 'State id. Generated from the prompt if omitted.' },
            rev: REV_PARAM,
          },
          async run(input, ctx) {
            const rev = await revFor(ctx.store, input.world, input.rev)
            const res = await ctx.store.addState(input.world, { base: input.base, ...(input.id ? { id: input.id } : {}) }, rev)
            return { rev: res.rev, diagnostics: res.diagnostics ?? [] }
          },
        }),
        update: defineTool({
          summary: 'Rewrite a state\'s prose or its ending.',
          description:
            'Each flag you pass overwrites that field; a flag you omit leaves it untouched. `--ending none` erases the ending — the difference between a control that can be turned off and one that only turns on. For the structured fields (camera, movement), compose an `update_state` op through `author ops`.',
          kind: 'mutation',
          params: {
            world: { type: 'string', describe: 'The world id.', required: true, positional: 0 },
            id: { type: 'string', describe: 'The state id.', required: true, positional: 1 },
            base: { type: 'string', describe: 'New base prompt.' },
            ending: { type: 'enum', describe: 'Mark this state as an ending, or clear it.', values: ['win', 'lose', 'none'] },
            title: { type: 'string', describe: 'Ending title. Only meaningful with --ending win|lose.' },
            subtitle: { type: 'string', describe: 'Ending subtitle. Only meaningful with --ending win|lose.' },
            rev: REV_PARAM,
          },
          async run(input, ctx) {
            const rev = await revFor(ctx.store, input.world, input.rev)
            const patch: NullablePatch<SMState> = {}
            if (input.base !== undefined) patch.base = input.base
            if (input.ending === 'none') patch.ending = null
            else if (input.ending === 'win' || input.ending === 'lose') {
              patch.ending = { kind: input.ending, title: input.title ?? '', ...(input.subtitle ? { subtitle: input.subtitle } : {}) }
            }
            const res = await ctx.store.updateState(input.world, input.id, patch, rev)
            return { rev: res.rev, diagnostics: res.diagnostics ?? [] }
          },
        }),
        delete: defineTool({
          summary: 'Delete a state. This cascades and can leave a world unplayable.',
          description:
            'Deleting a state also deletes every event that led only from it, strips it from the others, and clears the entrance if it was this state — which leaves a world that cannot be played until an entrance is set again. The diagnostics say exactly what went with it.',
          kind: 'mutation',
          params: {
            world: { type: 'string', describe: 'The world id.', required: true, positional: 0 },
            id: { type: 'string', describe: 'The state id.', required: true, positional: 1 },
            rev: REV_PARAM,
          },
          async run(input, ctx) {
            const rev = await revFor(ctx.store, input.world, input.rev)
            const res = await ctx.store.deleteState(input.world, input.id, rev)
            return { rev: res.rev, diagnostics: res.diagnostics ?? [] }
          },
        }),
      },
    }),

    event: defineTool({
      summary: 'Events: what moves a world between states, or changes the one it is in.',
      description:
        'A transition carries the world from one state to another. An override changes the current state without leaving it.',
      children: {
        add: defineTool({
          summary: 'Add an event to a world.',
          description:
            'A transition needs both --from and --to. An override needs only --from. The name is generated from the states when omitted, and is what the player sees on the beat rail.',
          kind: 'mutation',
          params: {
            world: { type: 'string', describe: 'The world id.', required: true, positional: 0 },
            from: { type: 'string', describe: 'State this event is available from.', required: true },
            to: { type: 'string', describe: 'State it moves to. Required for a transition.' },
            kind: { type: 'enum', describe: 'Whether it moves the machine or only recolours the current state.', values: ['transition', 'override'], default: 'transition' },
            name: { type: 'string', describe: 'Event name. Generated from the states if omitted.' },
            rev: REV_PARAM,
          },
          async run(input, ctx) {
            const rev = await revFor(ctx.store, input.world, input.rev)
            const kind: 'transition' | 'override' = input.kind === 'override' ? 'override' : 'transition'
            const res = await ctx.store.addEvent(
              input.world,
              { kind, from: input.from, ...(input.to ? { to: input.to } : {}), ...(input.name ? { name: input.name } : {}) },
              rev,
            )
            return { rev: res.rev, diagnostics: res.diagnostics ?? [] }
          },
        }),
        update: defineTool({
          summary: 'Rewrite an event\'s prose or re-point where it leads.',
          description:
            'Each flag you pass overwrites that field; a flag you omit leaves it untouched. To edit the structured fields (a pinned vision anchor, a hotkey), compose an `update_event` op through `author ops`.',
          kind: 'mutation',
          params: {
            world: { type: 'string', describe: 'The world id.', required: true, positional: 0 },
            name: { type: 'string', describe: 'The event name.', required: true, positional: 1 },
            base: { type: 'string', describe: 'New base prose for the state it moves to.' },
            detail: { type: 'string', describe: 'New override detail.' },
            to: { type: 'string', describe: 'Re-point the transition to this state.' },
            rev: REV_PARAM,
          },
          async run(input, ctx) {
            const rev = await revFor(ctx.store, input.world, input.rev)
            const patch: NullablePatch<SMEvent> = {}
            if (input.base !== undefined) patch.base = input.base
            if (input.detail !== undefined) patch.detail = input.detail
            if (input.to !== undefined) patch.to = input.to
            const res = await ctx.store.updateEvent(input.world, input.name, patch, rev)
            return { rev: res.rev, diagnostics: res.diagnostics ?? [] }
          },
        }),
        delete: defineTool({
          summary: 'Delete an event.',
          description: 'Removes the event only; the states it connected are left alone.',
          kind: 'mutation',
          params: {
            world: { type: 'string', describe: 'The world id.', required: true, positional: 0 },
            name: { type: 'string', describe: 'The event name.', required: true, positional: 1 },
            rev: REV_PARAM,
          },
          async run(input, ctx) {
            const rev = await revFor(ctx.store, input.world, input.rev)
            const res = await ctx.store.deleteEvent(input.world, input.name, rev)
            return { rev: res.rev, diagnostics: res.diagnostics ?? [] }
          },
        }),
      },
    }),

    entrance: defineTool({
      summary: 'Set the state a world opens in.',
      description:
        'A world with no entrance cannot be played: the player has nowhere to start and no beats to offer. Deleting the entrance state clears this, so it is worth re-setting after any structural edit.',
      kind: 'mutation',
      params: {
        world: { type: 'string', describe: 'The world id.', required: true, positional: 0 },
        state: { type: 'string', describe: 'The state to open in.', required: true, positional: 1 },
        // The SEED lives on the entrance because that is what it is a picture
        // of: the frame the world model continues from, and the frame the
        // anchor probe grounds against. It was writable only at create, so a
        // world whose opening prose had been rewritten kept a picture of the
        // premise it started life as.
        image: { type: 'string', describe: 'Opening frame as a data: URL. Omit to leave the current one.' },
        label: { type: 'string', describe: 'What the frame is, for the author.' },
        rev: REV_PARAM,
      },
      async run(input, ctx) {
        const rev = await revFor(ctx.store, input.world, input.rev)
        const body: { state: string; image?: { src: string; label?: string } } = { state: input.state }
        if (input.image) body.image = { src: input.image, ...(input.label ? { label: input.label } : {}) }
        const res = await ctx.store.setEntrance(input.world, body, rev)
        return { rev: res.rev, diagnostics: res.diagnostics ?? [] }
      },
    }),

    ops: defineTool({
      summary: 'Apply a batch of graph operations in one revision.',
      description:
        'The batch form of every state and event edit above, applied as one atomic write — this is what the language-model agent composes, and the only path for the structured fields the single-field flags do not reach. The ops are the store\'s own vocabulary (add_state, update_event, set_entrance, …); an unsupported op is rejected before anything is written.',
      kind: 'mutation',
      params: {
        world: { type: 'string', describe: 'The world id.', required: true, positional: 0 },
        ops: { type: 'json', describe: 'An array of {op, …} operations in the store\'s public vocabulary.', required: true },
        rev: REV_PARAM,
      },
      async run(input, ctx) {
        const rev = await revFor(ctx.store, input.world, input.rev)
        const ops = toPublicOps(input.ops)
        // THE PRODUCER BOUNDARY. An agent-origin batch has to clear the
        // doctrine before it is committed: machine-produced writes are
        // fail-closed, so a bad batch never lands, while a person's edits stay
        // advisory so authoring can boot dirty. See the gate in
        // `world/store/local.ts`.
        const res = await ctx.store.applyOps(input.world, ops, rev, { strict: ctx.origin === 'agent' })
        return { rev: res.rev, diagnostics: res.diagnostics ?? [] }
      },
    }),

    book: defineTool({
      summary: 'Turn a book into a campaign: several worlds, joined into one story.',
      description:
        "The whole path, end to end. Reads the text into beats and a bible, lays it out as a spine of acts, authors EACH act into its own world with the same kernel `author generate` uses, joins them into a macro-graph, saves it, and runs the six campaign lints on the result. Each act's painter gets its setting and the book's light — short, because an image prompt must be — while the kernel gets the act's summary and goal. A failure stops the run instead of saving a story with a hole in it: a campaign whose third act is missing is not a partial book, it is a story that ends in a wall, and the lints would refuse to open it anyway. Better to fail while you are still watching. Use `author chapter` for one chapter; this wants at least 1200 characters.",
      kind: 'mutation',
      params: {
        text: { type: 'string', describe: 'The book, or a long extract of it.', required: true, positional: 0 },
        acts: { type: 'number', describe: 'Roughly how many canonical acts to aim for. Default 4.' },
      },
      async run(input, ctx) {
        if (!ctx.llm || !ctx.llm.isConfigured()) {
          throw new Error('laying out a book needs a language model — configure one in Settings (Language model).')
        }
        return runBookToCampaign({
          llm: ctx.llm,
          store: ctx.store,
          ...(ctx.image ? { image: ctx.image } : {}),
          ...(ctx.vision ? { vision: ctx.vision } : {}),
          ...(ctx.progress ? { progress: ctx.progress } : {}),
          text: input.text,
          ...(typeof input.acts === 'number' ? { targetActs: input.acts } : {}),
        })
      },
    }),
    spine: defineTool({
      summary: 'Lay a book out as a macro-graph of acts, before any of them is authored.',
      description:
        "Reads a book's beats and bible on your own language model and returns its SHAPE: two to six acts, the golden thread a reader would recognise, and the edges between them — advance, branch, loop, end. It stops at a PLAN and authors nothing, because an act has no world until the kernel writes one, and the campaign type is right to demand a world it can open. Non-canonical acts are the roads the book did not take: a story where every road is the one taken is a recital, not a game. Edges naming an act nobody defined are dropped here rather than failing the campaign lints at open time. Pair it with `author chapter` per act; the macro-graph engine that plays the result is already in `world/campaign.ts`.",
      kind: 'query',
      params: {
        beats: { type: 'json', describe: 'The beats, as `author chapter` reports them: [{title, summary}].', required: true },
        bible: { type: 'json', describe: 'The bible, as `author chapter` reports it: {logline, protagonist, characters, locations, style}.', required: true },
        acts: { type: 'number', describe: 'Roughly how many canonical acts to aim for. Default 4.' },
      },
      async run(input, ctx) {
        if (!ctx.llm || !ctx.llm.isConfigured()) {
          throw new Error('laying out a book needs a language model — configure one in Settings (Language model).')
        }
        return spineFromBook(
          ctx.llm,
          toBeats(input.beats),
          toBible(input.bible),
          typeof input.acts === 'number' ? input.acts : 4,
        )
      },
    }),
    chapter: defineTool({
      summary: 'Turn a chapter of prose into a playable world, following its own beats.',
      description:
        "Reads a chapter TWICE on your own language model and then hands the result to the same kernel `author generate` uses. The first read finds what HAPPENS, in the order the chapter has it happening — four to eight beats, each one something that leaves the situation different. The second read finds what must stay CONSISTENT if it were drawn: a logline, the protagonist by appearance rather than by name, the characters and places actually seen, and a short atmosphere tail reused in every state. Both reads see the whole chapter rather than a summary, which is where fidelity comes from: a world built from a summary invents a sequence, and a reader who knows the chapter can tell at a glance. The kernel then authors the graph, so the doctrine gate and the self-correcting rounds are the same ones every other authoring path gets. This needs no server, only your key.",
      kind: 'mutation',
      params: {
        world: { type: 'string', describe: 'The world id to author into. It should be freshly created and empty.', required: true, positional: 0 },
        text: { type: 'string', describe: 'The chapter itself. Paste the prose; at least 400 characters.', required: true },
      },
      async run(input, ctx) {
        if (!ctx.llm || !ctx.llm.isConfigured()) {
          throw new Error(
            'reading a chapter needs a language model — configure one in Settings (Language model).',
          )
        }
        return runChapterToWorld({
          llm: ctx.llm,
          store: ctx.store,
          ...(ctx.image ? { image: ctx.image } : {}),
          ...(ctx.vision ? { vision: ctx.vision } : {}),
          ...(ctx.progress ? { progress: ctx.progress } : {}),
          worldId: input.world,
          text: input.text,
        })
      },
    }),
    generate: defineTool({
      summary: 'Author a whole world from a premise — the kernel that turns one sentence into a graph.',
      description:
        'Runs the kernel agent against the configured language model: it plans five to eight states, the beats between them, a real branch, and endings to win and lose — then writes them as ONE atomic batch, so a refused answer changes nothing. The doctrine checks the result and, when it rejects something, the agent is handed its own errors and asked to fix them (up to four rounds). When an image model is configured it paints the first frame from the premise before any of that, and when a vision model is ALSO configured it probes that frame for candidate objects first — only the ones actually detected are offered as anchor labels, so a click target the player could never hit is never authored. Needs a model configured in Settings; the terminal has no Settings, so from the CLI this reports what is missing rather than guessing.',
      kind: 'mutation',
      params: {
        world: { type: 'string', describe: 'The world id to author into. It should be freshly created and empty.', required: true, positional: 0 },
        premise: { type: 'string', describe: 'One sentence: who the player is and what the world is about.', required: true },
      },
      async run(input, ctx) {
        if (!ctx.llm || !ctx.llm.isConfigured()) {
          throw new Error(
            'authoring a world needs a language model — configure one in Settings (Language model). The terminal has no Settings, so `world create --premise` there writes a single opening state instead.',
          )
        }
        const res = await runGeneration({
          llm: ctx.llm,
          store: ctx.store,
          ...(ctx.image ? { image: ctx.image } : {}),
          ...(ctx.vision ? { vision: ctx.vision } : {}),
          ...(ctx.progress ? { progress: ctx.progress } : {}),
          worldId: input.world,
          premise: input.premise,
        })
        return res
      },
    }),

    quest: defineTool({
      summary: 'Author a MISSION from a frame — every step grounded on something the detector really found.',
      description:
        'Paints (or takes) one frame, probes it with the vision model, and authors ordered objectives that may only be grounded on the nouns the probe VERIFIED. An objective grounded on anything else comes back to the model as its own correction round, because an action on an undetectable object is an action the player can never take. The mission then compiles into the states, events, flags and endings the runtime plays. Needs a language model and a vision model; without a frame it needs an image model too.',
      kind: 'mutation',
      params: {
        world: { type: 'string', describe: 'The world to author the mission into.', required: true, positional: 0 },
        premise: { type: 'string', describe: 'What the quest is about.', required: true, positional: 1 },
      },
      async run(input, ctx) {
        if (!ctx.llm?.isConfigured()) {
          throw new Error('authoring a quest needs a language model — configure one in Settings (Language model).')
        }
        if (!ctx.vision?.isConfigured()) {
          throw new Error('a quest from a frame needs a vision model to verify what is IN the frame — configure Moondream in Settings (Vision), or use `author generate` for an ungrounded graph.')
        }
        return runQuestGeneration({
          llm: ctx.llm,
          store: ctx.store,
          vision: ctx.vision,
          ...(ctx.image ? { image: ctx.image } : {}),
          ...(ctx.progress ? { progress: ctx.progress } : {}),
          worldId: input.world,
          premise: input.premise,
        })
      },
    }),

    candidate: defineTool({
      summary: 'Show the exact prose one event of a program will stream to the world model.',
      description:
        "Compiles the program and assembles ONE event's prompt with the player's own assembler, so what you read is what a session sends — not a reconstruction of it. The layers fall back to the STATE the event fires from: an event overrides the prose but inherits the camera and movement around it, which is what makes an event a change to a scene rather than a scene of its own. `--variant dynamic` asks for the travelling layers, the pair a player sees while MOVING, which is the hardest thing to read off a graph by eye and the most worth comparing between two phrasings.",
      kind: 'query',
      params: {
        file: { type: 'string', describe: 'Path to the program module.', required: true, positional: 0 },
        event: { type: 'string', describe: 'Which event to assemble.', required: true, positional: 1 },
        from: { type: 'string', describe: 'Assemble it as fired FROM this state (default: the event\'s first).' },
        variant: { type: 'string', describe: 'static (standing still) or dynamic (travelling). Default static.' },
      },
      async run(input, ctx) {
        // The same node seam `compile` guards: a browser has no module loader,
        // and a leaf that pretends otherwise fails deep instead of at the door.
        if (!ctx.importModule) {
          throw new Error('reading a program needs a module loader — run this from the terminal (`studio author candidate <file> <event>`)')
        }
        const mod = await ctx.importModule(input.file)
        const program = mod['program']
        if (!isProgram(program)) {
          throw new Error(`${input.file} must export a stagecraft program as \`program\` (see examples/walk-to-the-bench.sc.ts)`)
        }
        return candidateFor(program, input.event, {
          ...(input.from ? { fromState: input.from } : {}),
          ...(input.variant === 'dynamic' ? { variant: 'dynamic' as const } : {}),
        })
      },
    }),
    compile: defineTool({
      summary: 'Compile a stagecraft program into a world — the doctrine runs BEFORE anything is written.',
      description:
        'Imports a program module (a `.sc.ts` file exporting `program`), runs the whole doctrine over what it assembles, and writes the result only if nothing failed. This is the language\'s point: a world that breaks a rule never reaches the store, the player, or a GPU — it fails here, naming the exact field. Errors refuse; warnings are printed and the world is written. Needs a filesystem and a module loader, so it is a TERMINAL leaf: the browser has neither and says so.',
      kind: 'mutation',
      params: {
        file: { type: 'string', describe: 'Path to the program module.', required: true, positional: 0 },
        world: { type: 'string', describe: 'Write into this existing world instead of creating one.' },
      },
      async run(input, ctx) {
        if (!ctx.importModule) {
          throw new Error('compiling a program needs a module loader — run this from the terminal (`studio author compile <file>`)')
        }
        const mod = await ctx.importModule(input.file)
        // Structural, not `instanceof`: a program module imported from another
        // path can carry its OWN copy of the language (two module realms, two
        // class identities), and a program compiled from a second copy is still
        // a program. Caught by a /tmp file importing the eDSL absolutely.
        const program = mod['program']
        if (!isProgram(program)) {
          throw new Error(`${input.file} must export a stagecraft program as \`program\` (see examples/walk-to-the-bench.sc.ts)`)
        }
        // THROWS on any doctrine error, before a single write.
        const { world, warnings } = program.compile()
        const scene = world.scene ?? { states: {}, events: [] }
        const worldId = input.world ?? (await ctx.store.createWorld({
          premise: world.description ?? world.name ?? 'compiled program',
          ...(world.name ? { name: world.name } : {}),
        })).worldId
        if (!worldId) throw new Error('could not create a world to compile into')

        // One atomic batch, through the same validated op path every other
        // write uses — a compiler that hand-wrote the store would be a second
        // way to make a world.
        const ops: PublicOp[] = []
        for (const [id, state] of Object.entries(scene.states)) ops.push({ op: 'add_state', id, ...state })
        if (world.entrance?.state) ops.push({ op: 'set_entrance', state: world.entrance.state })
        for (const event of scene.events) ops.push({ op: 'add_event', ...event })
        const rev = (await ctx.store.getScene(worldId)).rev
        await ctx.store.applyOps(worldId, ops, rev)
        // The quest RECORD beside the graph it compiled into. Without this the
        // states and events land and the objective panel has nothing to read —
        // half a mission, which is worse than none.
        if (world.missions?.length || world.subject || world.styleTail) {
          await ctx.store.updateWorld(worldId, {
            ...(world.missions?.length ? { missions: world.missions } : {}),
            ...(world.subject ? { subject: world.subject } : {}),
            ...(world.styleTail ? { styleTail: world.styleTail } : {}),
          })
        }
        return {
          world: worldId,
          states: Object.keys(scene.states).length,
          events: scene.events.length,
          missions: world.missions?.length ?? 0,
          warnings: warnings.map((w) => `[${w.lint}] ${w.path}: ${w.message}`),
        }
      },
    }),

    validate: defineTool({
      summary: 'Validate a world against the fail-closed gate — is it playable at all?',
      description:
        'Reports whether the world passes the hard gate, with the diagnostics that fail it. Offline the check is UNAVAILABLE (the authoring kernel is not vendored), and that is reported honestly — a check that did not run is never a pass.',
      kind: 'query',
      params: { world: { type: 'string', describe: 'The world id.', required: true, positional: 0 } },
      async run(input, ctx) {
        return ctx.store.validate(input.world)
      },
    }),

    lint: defineTool({
      summary: 'Lint a world against the doctrine — advisory, with a prompt budget.',
      description:
        'Softer than validate: style and doctrine warnings plus the prompt-token budget. Also UNAVAILABLE offline, reported as such rather than as a clean pass.',
      kind: 'query',
      params: { world: { type: 'string', describe: 'The world id.', required: true, positional: 0 } },
      async run(input, ctx) {
        return ctx.store.lint(input.world)
      },
    }),
  },
})
