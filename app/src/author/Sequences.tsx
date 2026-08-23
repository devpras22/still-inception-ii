/**
 * The set-piece track.
 *
 * A sequence is an ordered chain of states played as one unit. It shipped with
 * the runtime and no way to author one by hand — the same asymmetry arrival
 * evidence once had: writable by the agent, writable from the CLI, and not by
 * anyone with hands. A mechanic only a machine can author is a mechanic most
 * authors will never find.
 *
 * The editing model is deliberately plain. There is no `update_sequence` op,
 * and there does not need to be: a save is a remove and an add in ONE ops
 * batch, and `applyOps` is all-or-nothing, so a half-rewritten set-piece cannot
 * exist. That is cheaper than a third op and strictly harder to get wrong.
 */
import { useState } from 'react'
import { useClient } from '../studio'
import { Button, DangerButton, Field, Pill, Select, TextInput } from '../theme'
import type { EditorPanelProps } from './types'
import type { SMSequence, SMSequenceBeat } from '../world'

type DwellKind = 'settle' | 'input' | 'ms'

function dwellKind(beat: SMSequenceBeat): DwellKind {
  if (beat.dwell === undefined || beat.dwell === 'settle') return 'settle'
  if (beat.dwell === 'input') return 'input'
  return 'ms'
}

function dwellMs(beat: SMSequenceBeat): number {
  return typeof beat.dwell === 'object' ? beat.dwell.ms : 3000
}

export function SequencesPanel({ worldId, world, rev, reload, toast }: Pick<EditorPanelProps, 'worldId' | 'world' | 'rev' | 'reload' | 'toast'>) {
  const { tools } = useClient()
  const [busy, setBusy] = useState(false)
  /** The set-piece being edited, held locally so a beat can be moved several
   *  times before any of it is written. */
  const [draft, setDraft] = useState<SMSequence | null>(null)

  const sequences = world.sequences ?? []
  const stateIds = Object.keys(world.scene?.states ?? {})

  async function save(next: SMSequence): Promise<void> {
    if (next.beats.length === 0) {
      toast('A set-piece needs at least one beat', true)
      return
    }
    setBusy(true)
    try {
      // Remove-then-add, in ONE batch. The store applies a batch atomically, so
      // there is no moment where the world has half a set-piece in it.
      const ops = sequences.some((q) => q.id === next.id)
        ? [{ op: 'remove_sequence', id: next.id }, { op: 'add_sequence', ...next }]
        : [{ op: 'add_sequence', ...next }]
      const res = await tools.run('author.ops', { world: worldId, ops, rev }, { origin: 'app' })
      if (!res.ok) throw new Error(res.error.message)
      await reload()
      setDraft(null)
      toast('Set-piece saved')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the set-piece', true)
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string): Promise<void> {
    setBusy(true)
    try {
      const res = await tools.run('author.ops', { world: worldId, ops: [{ op: 'remove_sequence', id }], rev }, { origin: 'app' })
      if (!res.ok) throw new Error(res.error.message)
      await reload()
      if (draft?.id === id) setDraft(null)
      toast('Set-piece deleted')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not delete the set-piece', true)
    } finally {
      setBusy(false)
    }
  }

  function patchBeat(index: number, beat: SMSequenceBeat): void {
    setDraft((d) => (d ? { ...d, beats: d.beats.map((b, i) => (i === index ? beat : b)) } : d))
  }

  function moveBeat(index: number, by: -1 | 1): void {
    setDraft((d) => {
      if (!d) return d
      const to = index + by
      if (to < 0 || to >= d.beats.length) return d
      const beats = [...d.beats]
      const moving = beats[index]
      const other = beats[to]
      if (!moving || !other) return d
      beats[index] = other
      beats[to] = moving
      return { ...d, beats }
    })
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>Set-pieces</strong>
        <Pill>{sequences.length}</Pill>
      </div>
      <p className="muted" style={{ margin: '2px 0 0' }}>
        A chain of states the world walks by itself. Each beat waits its own way: until the picture
        settles, until the player acts, or for a set time.
      </p>

      {sequences.length === 0 && !draft && (
        <p className="muted" style={{ marginTop: 8 }}>None yet.</p>
      )}

      {sequences.map((q) => (
        <div key={q.id} className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
          <span>
            <code>{q.id}</code> <span className="muted">{q.title} · {q.beats.length} beats</span>
          </span>
          <span className="row" style={{ gap: 6 }}>
            <Button variant="ghost" text="Edit" disabled={busy} onClick={() => setDraft(structuredClone(q))} />
            <DangerButton
              text="Delete"
              disabled={busy}
              confirm={`Delete the set-piece "${q.title}"?\n\nThe states it walks stay; only the chain goes.`}
              onClick={() => void remove(q.id)}
            />
          </span>
        </div>
      ))}

      {draft && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line)' }}>
          <Field id="seq-id" label="Id">
            <TextInput id="seq-id" value={draft.id} spellCheck={false}
              onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
          </Field>
          <Field id="seq-title" label="Title">
            <TextInput id="seq-title" value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </Field>

          {draft.beats.map((beat, i) => (
            <div key={i} style={{ border: '1px solid var(--line)', borderRadius: 6, padding: 8, marginTop: 6 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <Pill>beat {i + 1}</Pill>
                <span className="row" style={{ gap: 4 }}>
                  {/* Named per beat: an arrow on its own has nothing to read
                      out, and "which ↑ did I press" is a question three
                      identical buttons in a column will always raise. */}
                  <Button variant="ghost" text="↑" title={`move beat ${i + 1} earlier`} aria-label={`move beat ${i + 1} earlier`}
                    disabled={i === 0} onClick={() => moveBeat(i, -1)} />
                  <Button variant="ghost" text="↓" title={`move beat ${i + 1} later`} aria-label={`move beat ${i + 1} later`}
                    disabled={i === draft.beats.length - 1} onClick={() => moveBeat(i, 1)} />
                  <Button variant="ghost" text="✕" title={`remove beat ${i + 1}`} aria-label={`remove beat ${i + 1}`}
                    onClick={() => setDraft({ ...draft, beats: draft.beats.filter((_, k) => k !== i) })} />
                </span>
              </div>
              <Field id={`seq-beat-state-${i}`} label="State">
                <Select id={`seq-beat-state-${i}`} value={beat.state} onChange={(e) => patchBeat(i, { ...beat, state: e.target.value })}>
                  {stateIds.map((s) => <option key={s} value={s}>{s}</option>)}
                </Select>
              </Field>
              <Field id={`seq-beat-dwell-${i}`} label={<>Dwell <span className="muted">(how this beat ends)</span></>}>
                <Select
                  id={`seq-beat-dwell-${i}`}
                  value={dwellKind(beat)}
                  onChange={(e) => {
                    const kind = e.target.value
                    patchBeat(i, {
                      state: beat.state,
                      ...(kind === 'ms' ? { dwell: { ms: dwellMs(beat) } } : kind === 'input' ? { dwell: 'input' as const } : { dwell: 'settle' as const }),
                    })
                  }}
                >
                  <option value="settle">until the picture settles</option>
                  <option value="input">until the player acts (ends the walk)</option>
                  <option value="ms">for a set time</option>
                </Select>
              </Field>
              {dwellKind(beat) === 'ms' && (
                <Field id={`seq-beat-ms-${i}`} label="Milliseconds">
                  <TextInput
                    id={`seq-beat-ms-${i}`}
                    inputMode="numeric"
                    value={String(dwellMs(beat))}
                    onChange={(e) => patchBeat(i, { state: beat.state, dwell: { ms: Number(e.target.value) || 0 } })}
                  />
                </Field>
              )}
            </div>
          ))}

          <div className="row" style={{ marginTop: 8, gap: 8 }}>
            <Button
              variant="ghost"
              text="+ beat"
              disabled={stateIds.length === 0}
              onClick={() => setDraft({ ...draft, beats: [...draft.beats, { state: stateIds[0] ?? '', dwell: 'settle' }] })}
            />
            <Button variant="primary" busy={busy} text="Save set-piece" onClick={() => void save(draft)} />
            <Button variant="ghost" text="Cancel" disabled={busy} onClick={() => setDraft(null)} />
          </div>
        </div>
      )}

      {!draft && (
        <div className="row" style={{ marginTop: 10 }}>
          <Button
            variant="ghost"
            text="+ New set-piece"
            disabled={busy || stateIds.length === 0}
            onClick={() => setDraft({ id: `set_piece_${sequences.length + 1}`, title: 'New set-piece', beats: [{ state: stateIds[0] ?? '', dwell: 'settle' }] })}
          />
        </div>
      )}
    </div>
  )
}
