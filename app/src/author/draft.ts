/**
 * Unsaved edits survive leaving the editor.
 *
 * The problem: the working graph lives in local state and only reaches storage
 * on an explicit save, so a reload drops edits. The graph is mirrored to
 * `localStorage` on a debounce, keyed by world id, and on reopen restored if it
 * differs from the saved version — with a banner, so the creator knows and can
 * revert.
 *
 * WHY THIS AND NOT AUTOSAVE. Writing the form to the store on a timer also stops
 * work being lost, and it was built first. It is the wrong trade: it makes every
 * exploratory keystroke real, so there is no way to try a phrasing and walk
 * away. A draft keeps "do not lose my work" and "commit this world" as separate
 * decisions, which is why the toolbar still has a save.
 *
 * The failure this exists for is not hypothetical: a doctrine error named a
 * phrase, the fix was typed, Play was pressed, the identical error came back —
 * because the edit had never been saved and nothing on screen said so.
 */

/** Where a form's draft lives. Scoped to the world AND the thing being edited,
 *  so a draft for one event cannot be restored into another. */
export function draftKey(worldId: string, selection: string): string {
  return `alakazam-studio:draft:${worldId}:${selection}`
}

/**
 * Is this draft worth restoring?
 *
 * Only when it differs from what was LOADED. A draft identical to the saved
 * values is not a recovery, it is noise — restoring it would show a banner
 * after every visit and train the reader to dismiss it unread.
 */
export function draftDiffers(draft: string | null, loaded: string): boolean {
  return draft !== null && draft.length > 0 && draft !== loaded
}

/** How long a pause means "stopped typing". Short enough that quitting right
 *  after an edit keeps it; long enough not to write per keystroke. */
export const DRAFT_MS = 500

export interface DraftStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Read a draft, tolerating a storage that refuses (private mode, quota). */
export function readDraft(store: DraftStore | undefined, key: string): string | null {
  try { return store?.getItem(key) ?? null } catch { return null }
}

export function writeDraft(store: DraftStore | undefined, key: string, value: string): void {
  try { store?.setItem(key, value) } catch { /* out of quota: the edit is still on screen */ }
}

/** Dropped on a real save, so a reload cannot resurrect a stale copy — the
 *  reason a real save clears the draft key. */
export function clearDraft(store: DraftStore | undefined, key: string): void {
  try { store?.removeItem(key) } catch { /* ignore */ }
}

/** What the header reads. One string, so a test can assert it without a form. */
export function draftLabel(dirty: boolean, recovered: boolean): string {
  if (recovered) return 'restored unsaved edits — save to keep them'
  return dirty ? '● unsaved' : 'saved'
}
