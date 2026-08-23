/**
 * The tool primitive's own contract.
 *
 * These are the invariants everything else in the tree leans on: that a summary
 * cannot silently be too long to render, that a mistyped mutation is never
 * guessed at, and that a parameter declaration really does drive parsing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { defineTool, resolve, leaves, recover, isLeaf } from '../../src/tool/define'
import { parseArgs, ToolInputError } from '../../src/tool/schema'
import { renderHelp, renderCompact } from '../../src/tool/help'
import { root } from '../../src/tool/root'

const leaf = () =>
  defineTool({
    summary: 'A leaf.',
    description: 'Does a thing.',
    kind: 'query' as const,
    params: {
      name: { type: 'string' as const, describe: 'A name.', required: true },
      count: { type: 'number' as const, describe: 'How many.', default: 3 },
      loud: { type: 'boolean' as const, describe: 'Shout.' },
      mode: { type: 'enum' as const, describe: 'Which mode.', values: ['a', 'b'] as const },
    },
    async run() { return null },
  })

test('a summary that cannot render in a listing is rejected at definition time', () => {
  assert.throws(() => defineTool({ summary: 'x'.repeat(121), description: 'd', children: {} }), /at most 120/)
  assert.throws(() => defineTool({ summary: 'two\nlines', description: 'd', children: {} }), /single line/)
})

test('a tool without a description, or a parameter without one, is rejected', () => {
  assert.throws(() => defineTool({ summary: 's', description: '  ', children: {} }), /description/)
  assert.throws(
    () => defineTool({ summary: 's', description: 'd', kind: 'query', params: { a: { type: 'string', describe: '' } }, async run() { return null } }),
    /needs a describe/,
  )
})

test('parameters drive parsing: flags, negation, defaults, enums, requiredness', () => {
  const t = leaf()
  assert.deepEqual(parseArgs(t.params, ['--name', 'x']), { name: 'x', count: 3 })
  assert.deepEqual(parseArgs(t.params, ['--name', 'x', '--count', '7']), { name: 'x', count: 7 })
  assert.equal(parseArgs(t.params, ['--name', 'x', '--loud'])['loud'], true)
  assert.equal(parseArgs(t.params, ['--name', 'x', '--no-loud'])['loud'], false)
  assert.throws(() => parseArgs(t.params, []), ToolInputError)
  assert.throws(() => parseArgs(t.params, ['--name', 'x', '--mode', 'z']), /one of: a, b/)
  assert.throws(() => parseArgs(t.params, ['--name', 'x', '--nope', '1']), /unknown option/)
  assert.throws(() => parseArgs(t.params, ['--name']), /needs a value/)
})

test('a mistyped query may auto-run; a mistyped mutation never does', () => {
  const found = recover(root, 'world.lst')
  assert.ok('tool' in found && found.corrected, 'a close query match should be corrected')
  assert.equal('path' in found ? found.path : '', 'world.list')

  const mutation = recover(root, 'world.delet')
  assert.ok(!('tool' in mutation), 'a mutation must never be auto-corrected into running')
  assert.equal('suggestion' in mutation ? mutation.suggestion : '', 'world.delete')
})

test('every leaf in the shipped tree declares kind, summary and described params', () => {
  const all = leaves(root)
  assert.ok(all.length >= 8, `expected a real tree, got ${all.length} leaves`)
  for (const { path, leaf: l } of all) {
    assert.ok(l.kind === 'query' || l.kind === 'mutation', `${path} has no kind`)
    assert.ok(l.summary.length <= 120 && !l.summary.includes('\n'), `${path} summary does not fit a listing`)
    assert.ok(l.description.trim().length > l.summary.length, `${path} description adds nothing over its summary`)
    for (const [name, p] of Object.entries(l.params)) {
      assert.ok(p.describe.trim().length > 0, `${path} --${name} is undocumented`)
    }
  }
})

test('help renders the contract, and the compact projection is much smaller', () => {
  const full = leaves(root).map(({ path }) => renderHelp(path, resolve(root, path)!)).join('')
  const compact = renderCompact(root)
  assert.ok(compact.length * 2 < full.length, `compact (${compact.length}) should be far smaller than full (${full.length})`)
  // The compact projection still names every command, or it is not a projection
  // of the tree — it is a different, smaller tree.
  for (const { path } of leaves(root)) {
    assert.ok(compact.includes(path.replace(/\./g, ' ')), `compact help omits ${path}`)
  }
})

test('resolve walks the tree and refuses to walk through a leaf', () => {
  assert.ok(resolve(root, 'world') && !isLeaf(resolve(root, 'world')!))
  assert.ok(isLeaf(resolve(root, 'world.list')!))
  assert.equal(resolve(root, 'world.list.nope'), undefined)
  assert.equal(resolve(root, 'nope'), undefined)
})
