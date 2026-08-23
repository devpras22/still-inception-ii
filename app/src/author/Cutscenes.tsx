/**
 * Clips on the seams.
 *
 * A cutscene is the author saying "not this one" — the doctrine here is to
 * "reserve cuts for the un-renderable (a grab, a death, a body-horror
 * tableau, the loop)". A world model will attempt anything you describe; this
 * is where you decline the attempt and show footage instead.
 *
 * Authored here rather than left to ops, because the runtime shipped in the
 * same change and a mechanic only a machine can author is one most authors
 * never find.
 */
import { useState } from 'react'
import { useClient } from '../studio'
import { Button, DangerButton, Field, Pill, Select, TextInput } from '../theme'
import { cutscenesFrom } from '../play'
import type { EditorPanelProps, EditorSelection } from './types'

export function CutscenesPanel({
  worldId,
  world,
  rev,
  reload,
  toast,
  selected,
}: Pick<EditorPanelProps, 'worldId' | 'world' | 'rev' | 'reload' | 'toast'> & { selected: EditorSelection }) {
  const { tools } = useClient()
  const [busy, setBusy] = useState(false)
  const [id, setId] = useState('')
  const [video, setVideo] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const cutscenes = world.cutscenes ?? []
  const stateIds = Object.keys(world.scene?.states ?? {})
  /** Cuts that leave whatever is selected — the seam an author is looking at. */
  const onThisSeam = cutscenesFrom(cutscenes, selected?.kind === 'state' ? selected.id : null)

  async function run(ops: Record<string, unknown>[], okMsg: string, after?: () => void): Promise<void> {
    setBusy(true)
    try {
      const res = await tools.run('author.ops', { world: worldId, ops, rev }, { origin: 'app' })
      if (!res.ok) throw new Error(res.error.message)
      await reload()
      toast(okMsg)
      after?.()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That did not work', true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>Cutscenes</strong>
        <Pill>{cutscenes.length}</Pill>
      </div>
      <p className="muted" style={{ margin: '2px 0 0' }}>
        A clip that plays instead of a transition — for what the model should not attempt. A transition
        pointing at a cutscene&apos;s id plays it, then lands where the cut says. A missing clip is skipped
        rather than blocking, so a world stays playable before its art lands.
      </p>

      {onThisSeam.length > 0 && (
        <p className="muted" style={{ marginTop: 6 }}>
          On this state&apos;s seam: {onThisSeam.map((c) => c.id).join(', ')}
        </p>
      )}

      {cutscenes.map((c) => (
        <div key={c.id} className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
          <span>
            <code>{c.id}</code>{' '}
            <span className="muted">{c.from} → {c.to}{c.label ? ` · ${c.label}` : ''}</span>
          </span>
          <DangerButton
            text="Delete"
            disabled={busy}
            confirm={`Delete the cutscene "${c.id}"?\n\nAny transition pointing at it will go straight to ${c.to} instead.`}
            onClick={() => void run([{ op: 'remove_cutscene', id: c.id }], 'Cutscene deleted')}
          />
        </div>
      ))}

      <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line)' }}>
        <Field id="cut-id" label={<>Id <span className="muted">(a transition&apos;s &quot;to&quot; names this)</span></>}>
          <TextInput id="cut-id" value={id} onChange={(e) => setId(e.target.value)} placeholder="c1" spellCheck={false} />
        </Field>
        <Field id="cut-video" label="Clip URL">
          <TextInput id="cut-video" value={video} onChange={(e) => setVideo(e.target.value)} placeholder="/clips/the-grab.webm" spellCheck={false} />
        </Field>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Field id="cut-from" label="After">
            <Select id="cut-from" value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">(pick a state)</option>
              {stateIds.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </Field>
          <Field id="cut-to" label="Lands in">
            <Select id="cut-to" value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">(pick a state)</option>
              {stateIds.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </Field>
        </div>
        <Button
          variant="primary"
          busy={busy}
          text="Add cutscene"
          disabled={busy || !id.trim() || !video.trim() || !from || !to}
          onClick={() => void run(
            [{ op: 'add_cutscene', id: id.trim(), video: video.trim(), from, to }],
            'Cutscene added',
            () => { setId(''); setVideo('') },
          )}
        />
      </div>
    </div>
  )
}
