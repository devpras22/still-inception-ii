/**
 * World operations, as tools.
 *
 * The world domain owns what a world is and where it lives, so it owns the
 * operations over that: listing, reading, creating, forking, updating and
 * deleting worlds; the version history each one carries; the storage it occupies;
 * and moving worlds in and out of the store as a bundle.
 *
 * These run against the injected store, which means the identical code path
 * serves the CLI (a JSON file) and the app (this browser). Nothing here knows
 * which it is — including `import`, which reads a path through an injected
 * `readTextFile` the CLI supplies and the browser does not, so this file never
 * names `node:fs` and stays safe to bundle.
 */

import { defineTool } from '../tool/define'

/** Optimistic-concurrency rev, the same optional contract the author writes use. */
const REV_PARAM = {
  type: 'string' as const,
  describe:
    'Optimistic-concurrency revision from a prior read. Pass the rev you authored against and a stale restore fails with a conflict; omit it and the current revision is read immediately before restoring.',
}

const version = defineTool({
  summary: 'Versions: the snapshot history a world carries, and moving between snapshots.',
  description:
    'A version is a frozen copy of a world\'s graph. Snapshots are taken by hand or before a risky change; restoring one checks the world out to that graph. Every version belongs to a world, which is why these live under it.',
  children: {
    list: defineTool({
      summary: 'List a world\'s versions, the snapshot history.',
      description: 'Every snapshot the world carries, newest first, with its title and lineage — the history you pick a --version out of for get, diff, or restore.',
      kind: 'query',
      params: { world: { type: 'string', describe: 'The world id.', required: true, positional: 0 } },
      async run(input, ctx) {
        return ctx.store.listVersions(input.world)
      },
    }),
    get: defineTool({
      summary: 'Read one version, including the full graph it froze.',
      description: 'Returns the snapshot exactly as it was captured — the way to inspect or recover a single past graph without restoring over the current one.',
      kind: 'query',
      params: {
        world: { type: 'string', describe: 'The world id.', required: true, positional: 0 },
        version: { type: 'string', describe: 'The version id.', required: true, positional: 1 },
      },
      async run(input, ctx) {
        return ctx.store.getVersion(input.world, input.version)
      },
    }),
    snapshot: defineTool({
      summary: 'Snapshot a world\'s current graph as a new version.',
      description: 'Freezes the graph as it stands now, optionally under a title. This is the checkpoint the editor takes before a restore, made available on its own so a caller can checkpoint whenever it wants.',
      kind: 'mutation',
      params: {
        world: { type: 'string', describe: 'The world id.', required: true, positional: 0 },
        title: { type: 'string', describe: 'A label for the snapshot.' },
        source: { type: 'string', describe: 'Where the snapshot came from, for history (e.g. manual, pre-restore).' },
      },
      async run(input, ctx) {
        const body = { ...(input.title ? { title: input.title } : {}), ...(input.source ? { source: input.source } : {}) }
        return ctx.store.snapshotVersion(input.world, body)
      },
    }),
    rename: defineTool({
      summary: 'Rename a version.',
      description: 'Changes only the label — the frozen graph is untouched. A version named "before the ending rewrite" is worth more than an opaque id when you come back to it.',
      kind: 'mutation',
      params: {
        world: { type: 'string', describe: 'The world id.', required: true, positional: 0 },
        version: { type: 'string', describe: 'The version id.', required: true, positional: 1 },
        title: { type: 'string', describe: 'The new title.', required: true, positional: 2 },
      },
      async run(input, ctx) {
        return ctx.store.renameVersion(input.world, input.version, input.title)
      },
    }),
    delete: defineTool({
      summary: 'Delete a version. The world itself is untouched.',
      description: 'Drops one snapshot from the history. The current graph is unaffected — this only prunes what you can restore back to, and is the usual way to reclaim the space `world storage` reports.',
      kind: 'mutation',
      params: {
        world: { type: 'string', describe: 'The world id.', required: true, positional: 0 },
        version: { type: 'string', describe: 'The version id.', required: true, positional: 1 },
      },
      async run(input, ctx) {
        return ctx.store.deleteVersion(input.world, input.version)
      },
    }),
    diff: defineTool({
      summary: 'Diff two versions: which states and events were added, removed, changed.',
      description: 'Compares two snapshots and reports the states and events that differ between them, split into added, removed, and changed — what actually moved between two points in a world\'s history.',
      kind: 'query',
      params: {
        world: { type: 'string', describe: 'The world id.', required: true, positional: 0 },
        a: { type: 'string', describe: 'The base version id.', required: true, positional: 1 },
        b: { type: 'string', describe: 'The version id to compare against the base.', required: true, positional: 2 },
      },
      async run(input, ctx) {
        return ctx.store.diffVersions(input.world, input.a, input.b)
      },
    }),
    restore: defineTool({
      summary: 'Restore a world to a past version, snapshotting the current graph first.',
      description:
        'Checks the world out to the chosen version. By default it snapshots the current graph before overwriting it, so the restore itself is undoable — a restore you cannot walk back is a worse trap than the state you were escaping. Pass --no-backup to skip that. The current revision is checked exactly as any graph write.',
      kind: 'mutation',
      params: {
        world: { type: 'string', describe: 'The world id.', required: true, positional: 0 },
        version: { type: 'string', describe: 'The version id to restore.', required: true, positional: 1 },
        backup: { type: 'boolean', describe: 'Snapshot the current graph before restoring.', default: true },
        rev: REV_PARAM,
      },
      async run(input, ctx) {
        const backup = input.backup
          ? await ctx.store.snapshotVersion(input.world, { source: 'pre-restore' })
          : undefined
        const rev = input.rev ?? (await ctx.store.getScene(input.world)).rev
        const res = await ctx.store.checkout(input.world, input.version, rev)
        return { world: res.world, rev: res.rev, ...(backup ? { backupVersion: backup.versionId } : {}) }
      },
    }),
  },
})

export const worldTools = defineTool({
  summary: 'Worlds: list, read, create, fork, update, delete, version, and move them in and out of the store.',
  description:
    'A world is a state machine: states hold the prose describing what the camera sees, events move between them. Every command here operates on whichever store is configured — a JSON file under the CLI, this browser in the app — and none of them needs an account or a network.',
  children: {
    list: defineTool({
      summary: 'List the worlds in the store, newest first.',
      description:
        'Reads the whole collection. The hosted store paginates and returns a cursor; the local store returns everything it has, because a browser profile holding enough worlds to need paging is not a case worth carrying complexity for.',
      kind: 'query',
      params: {
        limit: { type: 'number', describe: 'Maximum worlds to return.', default: 50 },
      },
      async run(input, ctx) {
        const res = await ctx.store.listWorlds({ limit: input.limit })
        return { worlds: res.worlds.map((w) => ({ id: w.id, name: w.name, updated: w['updated_at'] })) }
      },
    }),

    get: defineTool({
      summary: 'Read one world, including its full state graph.',
      description:
        'Returns the world document and its scene together, which is what any caller wanting to reason about the graph actually needs. A world id that does not exist is an error, not an empty result — silently returning nothing is how a typo becomes a confusing no-op.',
      kind: 'query',
      params: {
        id: { type: 'string', describe: 'The world id.', required: true, positional: 0 },
      },
      async run(input, ctx) {
        const [doc, scene] = await Promise.all([ctx.store.getWorld(input.id), ctx.store.getScene(input.id)])
        return { world: doc, scene }
      },
    }),

    create: defineTool({
      summary: 'Create a world, either the worked example or an empty one from a premise.',
      description:
        'With --example you get a worked example — `--template starter` (the default) is the three-state graph, `--template quest` is a MISSION that compiled itself into a graph, which is the one nobody would guess exists. The starter: an entrance, a transition, and an ending, which is the fastest way to have something real to take apart. With --premise alone, this leaf never calls a language model — you get a single entrance state seeded from that text, same from the terminal as from an unconfigured browser. On the hosted store, a hosted key plus --async additionally authors a full graph in the background, returning a job id to poll with `world job` instead of a finished world. On the local store, authoring the rest of the graph from a premise no longer needs a hosted key at all — a configured local language model does it — but only as a separate follow-up call (`author generate`), because the CLI has no LLM seam to run that through: from the terminal, a premise still only ever creates the single opening state this leaf writes.',
      kind: 'mutation',
      params: {
        premise: { type: 'string', describe: 'What the world is about. Seeds the entrance state.' },
        example: { type: 'boolean', describe: 'Create the worked example instead of an empty world.', default: false },
        template: { type: 'string', describe: 'Which worked example: "starter" (a three-state graph) or "quest" (a MISSION that compiled itself into one — a grounded step, a consequence, and a way to get it wrong).', default: 'starter' },
        async: { type: 'boolean', describe: 'Ask the hosted store to generate in the background; the result carries a job id for `world job`. The local store always creates instantly.', default: false },
        frame: { type: 'string', describe: 'A base64 seed image the created world anchors its look to. Hosted generation only.' },
      },
      async run(input, ctx) {
        if (!input.example && !input.premise) {
          throw new Error('give --premise TEXT, or --example for the worked example')
        }
        const res = await ctx.store.createWorld(
          input.example
            ? { template: input.template === 'quest' ? 'quest' : 'starter' }
            : {
                premise: input.premise,
                ...(input.async ? { async: true } : {}),
                ...(input.frame ? { frame_b64: input.frame } : {}),
              },
          `tool-${Date.now()}`,
        )
        return {
          ...(res.worldId ? { worldId: res.worldId } : {}),
          ...(res.jobId ? { jobId: res.jobId } : {}),
          ...(res.status ? { status: res.status } : {}),
        }
      },
    }),

    update: defineTool({
      summary: 'Update a world\'s metadata: its name, description, cover, or visibility.',
      description:
        'Edits the world\'s card, not its graph — the graph is what `author` operates on. Each flag you pass is written; a flag you omit is left alone. Visibility governs whether a world shows in the public community listing.',
      kind: 'mutation',
      params: {
        id: { type: 'string', describe: 'The world id.', required: true, positional: 0 },
        name: { type: 'string', describe: 'New display name.' },
        description: { type: 'string', describe: 'New description.' },
        cover: { type: 'string', describe: 'New cover image URL.' },
        visibility: { type: 'enum', describe: 'Who can see the world.', values: ['private', 'unlisted', 'public'] },
      },
      async run(input, ctx) {
        const patch = {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.cover !== undefined ? { cover: input.cover } : {}),
          ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        }
        if (Object.keys(patch).length === 0) throw new Error('give at least one field to update (--name, --description, --cover, --visibility)')
        return ctx.store.updateWorld(input.id, patch)
      },
    }),

    fork: defineTool({
      summary: 'Fork a world into a new, independent copy.',
      description:
        'Produces a new world with its own id, seeded from this one\'s current graph. The copy is disconnected — editing it never touches the original — which is how you take a world apart without fear of losing the version that worked.',
      kind: 'mutation',
      params: {
        id: { type: 'string', describe: 'The world id to fork.', required: true, positional: 0 },
      },
      async run(input, ctx) {
        return ctx.store.forkWorld(input.id)
      },
    }),

    delete: defineTool({
      summary: 'Delete a world from the store. There is no undo.',
      description:
        'Removes the world and every version snapshot it carries. Export it first if there is any chance it is wanted — the store keeps no trash.',
      kind: 'mutation',
      params: {
        id: { type: 'string', describe: 'The world id.', required: true, positional: 0 },
      },
      async run(input, ctx) {
        return ctx.store.deleteWorld(input.id)
      },
    }),

    job: defineTool({
      summary: 'Poll a world-generation job started by an async create.',
      description:
        'A hosted create from a premise runs asynchronously and hands back a job id; this reports where that job is and, once done, the world id it produced. The local store never issues jobs, so this is a hosted-only reader.',
      kind: 'query',
      params: {
        id: { type: 'string', describe: 'The job id returned by `world create`.', required: true, positional: 0 },
      },
      async run(input, ctx) {
        return ctx.store.getJob(input.id)
      },
    }),

    storage: defineTool({
      summary: 'Report how much room the store uses, worst offenders first.',
      description:
        'What is taking space, largest world first, with how much of each is version snapshots — the usual thing to prune. On a browser store it also reports whether the worlds are persistent or die with the tab, which the UI must be honest about.',
      kind: 'query',
      params: {},
      async run(_input, ctx) {
        return ctx.store.usage()
      },
    }),

    version,

    export: defineTool({
      summary: 'Export every world as one JSON bundle, for backup or for moving machines.',
      description:
        'The bundle carries the worlds and their version history. This is the answer to "my worlds are in a browser profile and I want them somewhere safer" — and to a full localStorage, where the studio tells the user to export before deleting. Not available on the hosted store, which is its own source of truth.',
      kind: 'query',
      params: {},
      async run(_input, ctx) {
        if (!ctx.store.info.transfer) throw new Error(`${ctx.store.info.label} does not support export`)
        return ctx.store.exportWorlds()
      },
    }),

    import: defineTool({
      summary: 'Import a bundle produced by export, merging it into the store.',
      description:
        'Worlds already present are skipped rather than overwritten, so importing the same bundle twice is safe and never destroys newer local work. Pass --file to read a bundle from a path (the CLI), or --bundle to hand the JSON directly (the app, which has no filesystem). The result reports what was added and what was skipped.',
      kind: 'mutation',
      params: {
        file: { type: 'string', describe: 'Path to a bundle written by `world export`. Needs a filesystem — the CLI.', positional: 0 },
        bundle: { type: 'json', describe: 'The bundle as JSON, for a caller with no filesystem — the app.' },
      },
      async run(input, ctx) {
        if (!ctx.store.info.transfer) throw new Error(`${ctx.store.info.label} does not support import`)
        let parsed: unknown
        if (input.bundle !== undefined) {
          parsed = input.bundle
        } else if (input.file !== undefined) {
          if (!ctx.readTextFile) throw new Error('reading a --file needs a filesystem; pass --bundle JSON instead')
          parsed = JSON.parse(await ctx.readTextFile(input.file))
        } else {
          throw new Error('give --file PATH (the CLI) or --bundle JSON (the app)')
        }
        return ctx.store.importWorlds(parsed)
      },
    }),
  },
})
