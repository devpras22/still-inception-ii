/**
 * Unsaved edits survive leaving the editor.
 *
 * The failure it exists for, verbatim from testing: a doctrine error named a
 * phrase, the fix was typed, Play was pressed, and the identical error came
 * back, because the edit had never been saved and nothing on screen said so.
 *
 * A DRAFT, not an autosave. Writing the form to the store on a timer also stops
 * work being lost — I built that first — but it makes every exploratory
 * keystroke real, so there is no way to try a phrasing and walk away. "Do not
 * lose my work" and "commit this world" stay separate decisions, which is why
 * there is still an explicit save.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DRAFT_MS, clearDraft, draftDiffers, draftKey, draftLabel, readDraft, writeDraft } from '../../src/author/draft'

const store = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) }, size: () => m.size }
}

test('a draft is scoped to the world AND the thing being edited', () => {
  // Without the selection, a draft for one event restores into another; without
  // the world, a draft crosses between worlds that share an event name.
  assert.notEqual(draftKey('w1', 'event:cross'), draftKey('w1', 'event:enter'))
  assert.notEqual(draftKey('w1', 'event:cross'), draftKey('w2', 'event:cross'))
})

test('only a draft that DIFFERS is worth restoring', () => {
  const loaded = '["the lane"]'
  assert.equal(draftDiffers('["the lane, colder"]', loaded), true)
  // Identical is not a recovery — restoring it would show a banner on every
  // visit and train the reader to dismiss it unread.
  assert.equal(draftDiffers(loaded, loaded), false)
  assert.equal(draftDiffers(null, loaded), false)
  assert.equal(draftDiffers('', loaded), false)
})

test('a save drops the draft, so a reload cannot resurrect a stale copy', () => {
  const s = store()
  const k = draftKey('w1', 'event:cross')
  writeDraft(s, k, '["half-typed"]')
  assert.equal(readDraft(s, k), '["half-typed"]')
  clearDraft(s, k)
  assert.equal(readDraft(s, k), null)
  assert.equal(s.size(), 0, 'and leaves nothing behind')
})

test('storage that refuses is survivable', () => {
  // Private mode and quota exhaustion both throw. The edit is still on screen;
  // losing the mirror must not take the form down with it.
  const hostile = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('quota') }, removeItem: () => { throw new Error('denied') } }
  assert.equal(readDraft(hostile, 'k'), null)
  assert.doesNotThrow(() => writeDraft(hostile, 'k', 'v'))
  assert.doesNotThrow(() => clearDraft(hostile, 'k'))
})

test('the header never says "saved" while a write is owed', () => {
  assert.equal(draftLabel(false, false), 'saved')
  assert.match(draftLabel(true, false), /unsaved/)
  assert.match(draftLabel(false, true), /restored/)
  assert.ok(DRAFT_MS > 0 && DRAFT_MS <= 1000)
})
