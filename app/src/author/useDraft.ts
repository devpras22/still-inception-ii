/**
 * The React half of the draft model. See `draft.ts` for why this exists and why
 * it is a draft rather than an autosave.
 */
import { useEffect, useRef, useState } from 'react'
import { DRAFT_MS, clearDraft, draftDiffers, draftKey, readDraft, writeDraft } from './draft'

export interface Draft {
  /** The form differs from what was loaded or last saved. */
  dirty: boolean
  /** A draft from a previous visit was restored into the form. */
  recovered: boolean
  /** Call after a successful save: the draft is dropped and the form is clean. */
  saved: () => void
  /** Throw the draft away and put the loaded values back. */
  revert: () => void
}

/**
 * @param worldId    which world
 * @param selection  which thing in it (a state id, an event name)
 * @param current    the form's values right now, serialised
 * @param loaded     the values the form OPENED with, serialised
 * @param restore    hand back a recovered draft so the form can adopt it
 */
export function useDraft(
  worldId: string,
  selection: string,
  current: string,
  loaded: string,
  restore: (draft: string) => void,
): Draft {
  const key = draftKey(worldId, selection)
  const [recovered, setRecovered] = useState(false)
  const [clean, setClean] = useState(loaded)
  const checked = useRef<string | null>(null)
  const restoreRef = useRef(restore)
  restoreRef.current = restore

  // RECOVERY, once per selection. Checked before any write, or the debounce
  // below would overwrite the draft with the loaded values first.
  useEffect(() => {
    if (checked.current === key) return
    checked.current = key
    setRecovered(false)
    setClean(loaded)
    const draft = readDraft(globalThis.localStorage, key)
    if (draftDiffers(draft, loaded) && draft !== null) {
      restoreRef.current(draft)
      setRecovered(true)
    }
  }, [key, loaded])

  // MIRROR, debounced. Only while the form differs from clean: writing an
  // unchanged form would leave a draft behind for every world merely opened.
  useEffect(() => {
    if (checked.current !== key || current === clean) return
    const t = window.setTimeout(() => writeDraft(globalThis.localStorage, key, current), DRAFT_MS)
    return () => window.clearTimeout(t)
  }, [key, current, clean])

  return {
    dirty: current !== clean,
    recovered,
    saved: () => { clearDraft(globalThis.localStorage, key); setClean(current); setRecovered(false) },
    revert: () => { clearDraft(globalThis.localStorage, key); restoreRef.current(clean); setRecovered(false) },
  }
}
