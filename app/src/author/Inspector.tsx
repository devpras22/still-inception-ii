import { useState } from 'react'
import type { NullablePatch } from '../world'
import { useClient } from '../studio'
import { getImageProvider } from '../provider'
import { repaintEntrance } from './agent/generate'
import { SequencesPanel } from './Sequences'
import { CutscenesPanel } from './Cutscenes'
import type { EditorPanelProps } from './types'
import type { SMState, SMEvent, SMEventPhase, SMDrive, SMLandWhen, SMPromptVariant, Diagnostic } from '../world'
import { Button, DangerButton, Checkbox, Field, Pill, Select, TextArea, TextInput } from '../theme'
import { draftLabel } from './draft'
import { useDraft } from './useDraft'

/**
 * Inspector — deterministic state/event editor. Every write goes through the
 * tool tree (`tools.run`) — the same leaves the CLI runs, dispatched through
 * one uniform envelope instead of hand-rolled store calls. `rev` still rides
 * along as the optimistic-concurrency check: a stale write comes back as a
 * conflict, and the panel reloads + tells the user to retry. Diagnostics
 * returned by each write are surfaced inline.
 */
export function Inspector({ worldId, world, rev, reload, selected, select, toast }: EditorPanelProps) {
  const [introVideo, setIntroVideo] = useState(world.introVideo ?? '')
  const [introStatic, setIntroStatic] = useState(!!world.introStatic)
  const [painting, setPainting] = useState(false)
  const [paintNote, setPaintNote] = useState<string | null>(null)

  /** Paint a new opening frame from the entrance's own prose. Says what is
   *  missing rather than failing quietly: a repaint that silently did nothing
   *  would leave an author staring at the frame they were trying to replace. */
  async function repaint(): Promise<void> {
    setPainting(true)
    setPaintNote(null)
    try {
      const res = await repaintEntrance({ image: getImageProvider(providers), store, tools, worldId })
      await reload()
      toast('Opening frame repainted')
      setPaintNote(`Painted from: "${res.prompt.slice(0, 90)}${res.prompt.length > 90 ? '…' : ''}"`)
    } catch (e) {
      const message = e instanceof Error ? e.message : 'the image model could not be reached'
      toast('Repaint failed', true)
      setPaintNote(message)
    } finally {
      setPainting(false)
    }
  }
  const { tools, store, providers } = useClient()
  const [busy, setBusy] = useState(false)
  const [diags, setDiags] = useState<Diagnostic[]>([])

  const states = world.scene?.states ?? {}
  const events = world.scene?.events ?? []
  const stateIds = Object.keys(states)

  const selState = selected?.kind === 'state' ? selected.id : null
  const selEvent = selected?.kind === 'event' ? selected.name : null
  const st = selState ? states[selState] : undefined
  const ev = selEvent ? events.find((e) => e.name === selEvent) : undefined

  // Add-state / add-event / entrance form state (persistent — not per-selection).
  const [newStateId, setNewStateId] = useState('')
  const [newStateBase, setNewStateBase] = useState('')
  const [evKind, setEvKind] = useState<'transition' | 'override'>('transition')
  const [evFrom, setEvFrom] = useState(stateIds[0] ?? '')
  const [evTo, setEvTo] = useState('')
  const [evName, setEvName] = useState('')
  const [entranceState, setEntranceState] = useState(world.entrance?.state ?? stateIds[0] ?? '')

  /** Run a tool-tree write, then reload + surface diagnostics. A stale-revision
   *  conflict reloads and asks the user to retry instead of surfacing an error. */
  async function run(path: string, input: Record<string, unknown>, okMsg: string, after?: () => void) {
    if (busy) return
    setBusy(true)
    try {
      const outcome = await tools.run(path, { ...input, rev })
      if (outcome.ok) {
        setDiags(outcome.diagnostics)
        await reload()
        after?.()
        toast(okMsg)
      } else if (outcome.error.conflict) {
        await reload()
        toast('reload & retry', true)
      } else {
        setDiags(outcome.error.diagnostics)
        toast(outcome.error.message || 'write failed', true)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {diags.length > 0 && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>Diagnostics</strong>
            <Button variant="ghost" text="clear" onClick={() => setDiags([])} />
          </div>
          <Diags items={diags} />
        </div>
      )}

      {/* Keyed on identity, NOT on revision. Keying on `rev` remounted the form
          after every write in the panel, and a remount re-initialises each
          useState from the store — so typing a long prompt and then pressing
          "Set entrance" (or hitting a 409, whose handler reloads) silently threw
          the prompt away and toasted success. */}
      {/* ── Selected state ─────────────────────────────────────────────── */}
      {selState && st && (
        <StateForm
          key={`state:${selState}`}
          stateId={selState}
          st={st}
          playWorldId={worldId}
          busy={busy}
          onSave={(patch) => run('author.ops', { world: worldId, ops: [{ op: 'update_state', id: selState, patch }] }, 'State saved')}
          onDelete={() => run('author.state.delete', { world: worldId, id: selState }, 'State deleted', () => select(null))}
        />
      )}
      {selState && !st && <div className="card muted">State “{selState}” is no longer in the graph.</div>}

      {/* ── Selected event ─────────────────────────────────────────────── */}
      {selEvent && ev && (
        <EventForm
          key={`event:${selEvent}`}
          ev={ev}
          stateIds={stateIds}
          cutsceneIds={(world.cutscenes ?? []).map((c) => c.id)}
          mintedFlags={[...new Set(world.scene.events.flatMap((e) => e.grants ?? []))].sort()}
          busy={busy}
          worldId={worldId}
          onSave={(patch) => run('author.ops', { world: worldId, ops: [{ op: 'update_event', name: selEvent, patch }] }, 'Event saved')}
          onDelete={() => run('author.event.delete', { world: worldId, name: selEvent }, 'Event deleted', () => select(null))}
        />
      )}
      {selEvent && !ev && <div className="card muted">Event “{selEvent}” is no longer in the graph.</div>}

      {!selected && <div className="card muted">Select a state or event in the graph to edit it — or use the tools below.</div>}

      {/* ── Add state ──────────────────────────────────────────────────── */}
      <div className="card">
        <strong>Add state</strong>
        <Field id="insp-new-state-id" label={<>ID <span className="muted">(optional — auto-generated if blank)</span></>}>
          <TextInput id="insp-new-state-id" value={newStateId} onChange={(e) => setNewStateId(e.target.value)} placeholder="e.g. vault_open" spellCheck={false} />
        </Field>
        <Field id="insp-new-state-base" label="Base prompt">
          <TextArea id="insp-new-state-base" value={newStateBase} onChange={(e) => setNewStateBase(e.target.value)} placeholder="What the camera sees in this state." />
        </Field>
        <div className="row" style={{ marginTop: 10 }}>
          <Button
            variant="primary"
            busy={busy}
            disabled={!newStateBase.trim()}
            text="＋ Add state"
            onClick={() => {
              const id = newStateId.trim()
              run(
                'author.state.add',
                { world: worldId, id: id || undefined, base: newStateBase.trim() },
                'State added',
                () => {
                  setNewStateId('')
                  setNewStateBase('')
                  if (id) select({ kind: 'state', id })
                },
              )
            }}
          />
        </div>
      </div>

      {/* ── Add event ──────────────────────────────────────────────────── */}
      <div className="card">
        <strong>Add event</strong>
        <Field id="insp-new-event-kind" label="Kind">
          <Select id="insp-new-event-kind" value={evKind} onChange={(e) => setEvKind(e.target.value === 'override' ? 'override' : 'transition')}>
            <option value="transition">transition</option>
            <option value="override">override</option>
          </Select>
        </Field>
        <Field id="insp-new-event-from" label="From state">
          <Select id="insp-new-event-from" value={evFrom} onChange={(e) => setEvFrom(e.target.value)}>
            {stateIds.length === 0 && <option value="">(no states yet)</option>}
            {stateIds.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        </Field>
        <Field id="insp-new-event-to" label={<>To state <span className="muted">(optional for override)</span></>}>
          <Select id="insp-new-event-to" value={evTo} onChange={(e) => setEvTo(e.target.value)}>
            <option value="">(none)</option>
            {stateIds.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        </Field>
        <Field id="insp-new-event-name" label={<>Name <span className="muted">(optional)</span></>}>
          <TextInput id="insp-new-event-name" value={evName} onChange={(e) => setEvName(e.target.value)} placeholder="e.g. open_vault" spellCheck={false} />
        </Field>
        <div className="row" style={{ marginTop: 10 }}>
          <Button
            variant="primary"
            busy={busy}
            disabled={!evFrom}
            text="＋ Add event"
            onClick={() =>
              run(
                'author.event.add',
                { world: worldId, kind: evKind, from: evFrom, to: evTo || undefined, name: evName.trim() || undefined },
                'Event added',
                () => setEvName(''),
              )
            }
          />
        </div>
      </div>

      {/* ── Set entrance ───────────────────────────────────────────────── */}
      <div className="card">
        <strong>Entrance</strong>
        <p className="muted" style={{ margin: '4px 0 0' }}>The state a player lands in. Currently: <code>{world.entrance?.state ?? '—'}</code></p>
        <Field id="insp-entrance-state" label="Entrance state">
          <Select id="insp-entrance-state" value={entranceState} onChange={(e) => setEntranceState(e.target.value)}>
            {stateIds.length === 0 && <option value="">(no states yet)</option>}
            {stateIds.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        </Field>
        <div className="row" style={{ marginTop: 10 }}>
          <Button
            variant="primary"
            disabled={busy || !entranceState}
            text="Set entrance"
            onClick={() => run('author.entrance', { world: worldId, state: entranceState }, 'Entrance set')}
          />
          {/* REPAINT. The seed was paintable only at create, so a world whose
              opening prose had been rewritten kept a picture of the premise it
              started life as — and the seed is not decoration: it is the frame
              the model continues FROM. This paints from the entrance's own
              prose, which is the better source that exists only afterwards. */}
          <Button
            variant="ghost"
            busy={painting}
            disabled={busy || painting}
            text="↻ Repaint opening frame"
            title="paint a new opening frame from the entrance state's own prose, using your image model"
            onClick={() => void repaint()}
          />
        </div>
        {paintNote && <p className="muted" style={{ margin: '6px 0 0' }}>{paintNote}</p>}

        {/* THE BOOKENDS. An intro clip covers the boot (author the entrance
            seed as its LAST frame and the cut is invisible); "ends still" says
            whether the world should come out of it standing or moving. */}
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line)' }}>
          <strong style={{ color: 'var(--acc)' }}>Bookends</strong>
          <Field id="insp-intro-video" label={<>Intro clip <span className="muted">(plays over the boot)</span></>}>
            <TextInput id="insp-intro-video" value={introVideo} onChange={(e) => setIntroVideo(e.target.value)} placeholder="/clips/open.webm" spellCheck={false} />
          </Field>
          <Checkbox
            checked={introStatic}
            onChange={setIntroStatic}
            label="The intro ends on a still subject (boot standing, not moving)"
          />
          <div className="row" style={{ marginTop: 8 }}>
            <Button
              variant="ghost"
              busy={busy}
              text="Save intro"
              onClick={() => run('author.ops', { world: worldId, ops: [{ op: 'set_intro', video: introVideo.trim() || null, static: introStatic }] }, 'Intro saved')}
            />
          </div>
        </div>

        {/* AUTO-NARRATION. Off by default and worth keeping off on a world you
            narrated yourself: the derivation strips the camera language off a
            state's base, which is a decent line for a world nobody wrote one
            for and a worse one than anything an author would write. */}
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line)' }}>
          <Checkbox
            checked={!!world.narrate}
            onChange={(on) => run('author.ops', { world: worldId, ops: [{ op: 'set_narrate', narrate: on }] }, on ? 'Auto-narration on' : 'Auto-narration off')}
            label="Narrate states that have no narration of their own"
          />
        </div>
      </div>

      {/* The set-piece track. Authoring one meant writing ops by hand until
          this panel existed — the runtime landed before its surface, the same
          asymmetry arrival evidence had. */}
      <SequencesPanel worldId={worldId} world={world} rev={rev} reload={reload} toast={toast} />

      {/* Clips on the seams — shipped with their runtime rather than after it. */}
      <CutscenesPanel worldId={worldId} world={world} rev={rev} reload={reload} toast={toast} selected={selected} />
    </div>
  )
}

// ── Sub-forms (remounted per selection via `key`, so they init from world) ────

function StateForm({ stateId, st, busy, onSave, onDelete, playWorldId }: {
  stateId: string
  st: SMState
  /** For the per-arm play links — an A/B is only meaningful against a world. */
  playWorldId: string
  busy: boolean
  onSave: (patch: NullablePatch<SMState>) => void
  onDelete: () => void
}) {
  const [base, setBase] = useState(st.base ?? '')
  const [camStatic, setCamStatic] = useState(st.camera?.static ?? '')
  const [camDynamic, setCamDynamic] = useState(st.camera?.dynamic ?? '')
  const [movStatic, setMovStatic] = useState(st.movement?.static ?? '')
  const [movDynamic, setMovDynamic] = useState(st.movement?.dynamic ?? '')
  const [endingOn, setEndingOn] = useState(!!st.ending)
  const [endingKind, setEndingKind] = useState<'win' | 'lose'>(st.ending?.kind ?? 'win')
  const [endingTitle, setEndingTitle] = useState(st.ending?.title ?? '')
  const [endingSubtitle, setEndingSubtitle] = useState(st.ending?.subtitle ?? '')
  const [narration, setNarration] = useState(st.narration ?? '')
  // AMBIENT — the world's small moving things. Authored by the kernel in every
  // world it makes, and until recently read by nothing at all; there was no
  // editor because there was no consumer. There is one now (a line rides the
  // streamed prompt for 7s at an 8-20s cadence), so a human can finally write
  // and fix them. One per line: they are separate transients, not a sentence,
  // and a comma-separated field would invite one long clause that never clears.
  const [ambient, setAmbient] = useState((st.ambient ?? []).join('\n'))
  const [autoMove, setAutoMove] = useState(st.autopilot?.movement ?? '')
  const [autoLookH, setAutoLookH] = useState(st.autopilot?.lookHorizontal ?? '')
  const [autoKeep, setAutoKeep] = useState(st.autopilot?.keepCentered?.label ?? '')
  const [arriveLabel, setArriveLabel] = useState(st.arriveLabel ?? '')
  /**
   * A/B. `null` is A — the state's own prose; otherwise the label of the
   * variant being edited. One form, a segmented control that decides WHICH
   * prose it is editing, and a play button per arm that boots the same seed
   * with different words.
   *
   * Until now `variants` was typed `unknown[]`, written by two ops and read by
   * nothing — the shape a feature takes when it exists in the schema and
   * nowhere else.
   */
  const variants: SMPromptVariant[] = st.variants ?? []
  const [pendingVariants, setPendingVariants] = useState<SMPromptVariant[]>(variants)
  const [arm, setArm] = useState<string | null>(null)


  /**
   * Every field is two-way, including the ones being cleared.
   *
   * This used to build the patch out of `if (value)` guards, which made every
   * control a ONE-WAY SWITCH: untick "this state is an ending", or empty both
   * camera fields, and the key was simply left out of the patch — the merge
   * skips undefined, so the old value survived and the UI silently disagreed
   * with the stored world. And because the form had no subtitle input, pressing
   * "Save state" on the shipped example world without typing anything deleted
   * its authored ending subtitle: a partial object written over a complete one.
   * `null` is the explicit erase; `undefined` would mean "leave alone".
   */
  /** Switch arms, carrying whatever is typed into the arm being left — so
   *  clicking B and back to A does not quietly discard an edit. */
  function selectArm(next: string | null) {
    const current: SMPromptVariant | null =
      arm === null
        ? null
        : { label: arm, base, ...(camStatic || camDynamic ? { camera: { static: camStatic, dynamic: camDynamic } } : {}), ...(movStatic || movDynamic ? { movement: { static: movStatic, dynamic: movDynamic } } : {}) }
    const pending = current ? variants.map((v) => (v.label === arm ? current : v)) : variants
    const target = next === null ? null : pending.find((v) => v.label === next) ?? null
    setPendingVariants(pending)
    setArm(next)
    setBase(target ? target.base : st.base ?? '')
    setCamStatic(target ? target.camera?.static ?? '' : st.camera?.static ?? '')
    setCamDynamic(target ? target.camera?.dynamic ?? '' : st.camera?.dynamic ?? '')
    setMovStatic(target ? target.movement?.static ?? '' : st.movement?.static ?? '')
    setMovDynamic(target ? target.movement?.dynamic ?? '' : st.movement?.dynamic ?? '')
  }

  // DRAFT, not autosave. Every field `save()` reads, serialised: the form
  // mirrors this to localStorage on a pause and restores it on reopen, while
  // the store is still only written by an explicit save. See `draft.ts`.
  const fields = JSON.stringify([base, camStatic, camDynamic, movStatic, movDynamic, ambient, narration, arriveLabel, endingOn, endingKind, endingTitle, endingSubtitle])
  const loadedFields = JSON.stringify([st.base ?? '', st.camera?.static ?? '', st.camera?.dynamic ?? '', st.movement?.static ?? '', st.movement?.dynamic ?? '', (st.ambient ?? []).join('\n'), st.narration ?? '', st.arriveLabel ?? '', !!st.ending, st.ending?.kind ?? 'win', st.ending?.title ?? '', st.ending?.subtitle ?? ''])
  const draft = useDraft(playWorldId ?? '', `state:${stateId}`, fields, loadedFields, (raw) => {
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return
    const str = (i: number) => (typeof v[i] === 'string' ? v[i] : '')
    setBase(str(0)); setCamStatic(str(1)); setCamDynamic(str(2)); setMovStatic(str(3)); setMovDynamic(str(4))
    setAmbient(str(5)); setNarration(str(6)); setArriveLabel(str(7))
    setEndingOn(v[8] === true); setEndingKind(v[9] === 'lose' ? 'lose' : 'win'); setEndingTitle(str(10)); setEndingSubtitle(str(11))
  })

  function save() {
    // Saving while editing an ARM writes the arm, not the state: the fields on
    // screen belong to whichever arm the segmented control has selected, and
    // writing them onto A would overwrite the thing being compared against.
    if (arm !== null) {
      const next = pendingVariants.map((v) =>
        v.label === arm
          ? {
              label: arm,
              base,
              ...(camStatic || camDynamic ? { camera: { static: camStatic, dynamic: camDynamic } } : {}),
              ...(movStatic || movDynamic ? { movement: { static: movStatic, dynamic: movDynamic } } : {}),
            }
          : v,
      )
      onSave({ variants: next })
      return
    }
    const patch: NullablePatch<SMState> = { base }
    // Erased when empty rather than written as `[]`: a state carrying an empty
    // ambient list reads as "the author decided this place is silent", when it
    // means nobody filled it in. The same rule the locks and the anchor follow.
    const ambientLines = ambient.split('\n').map((l) => l.trim()).filter(Boolean)
    patch.ambient = ambientLines.length ? ambientLines : null
    patch.camera = camStatic || camDynamic ? { static: camStatic, dynamic: camDynamic } : null
    patch.movement = movStatic || movDynamic ? { static: movStatic, dynamic: movDynamic } : null
    patch.ending = endingOn
      ? { kind: endingKind, title: endingTitle, ...(endingSubtitle ? { subtitle: endingSubtitle } : {}) }
      : null
    const auto: NonNullable<SMState['autopilot']> = {}
    const aMove = MOVE_VALUES.find((v) => v === autoMove)
    const aLookH = LOOK_H_VALUES.find((v) => v === autoLookH)
    if (aMove) auto.movement = aMove
    if (aLookH) auto.lookHorizontal = aLookH
    if (autoKeep.trim()) auto.keepCentered = { label: autoKeep.trim() }
    patch.autopilot = Object.keys(auto).length ? auto : null
    patch.narration = narration.trim() ? narration : null
    patch.arriveLabel = arriveLabel.trim() ? arriveLabel : null
    if (pendingVariants !== variants) patch.variants = pendingVariants.length ? pendingVariants : null
    onSave(patch)
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>State <code>{stateId}</code></strong>
        <Pill>state</Pill>
      </div>

      {/* WHAT THE PLAYER READS. The only prose on this form that is not a
          prompt — no lint polices it, and it is never sent to the model. */}
      <Field
        id="insp-state-ambient"
        label={<>Ambient <span className="muted">(one per line; each rides the prompt briefly, then clears)</span></>}
      >
        <TextArea
          id="insp-state-ambient"
          rows={3}
          value={ambient}
          onChange={(e) => setAmbient(e.target.value)}
          placeholder={'Ivy trembling in the breeze\nCrows calling in the distance'}
        />
      </Field>

      <Field id="insp-state-narration" label={<>Narration <span className="muted">(shown to the player; not sent to the model)</span></>}>
        <TextArea id="insp-state-narration" value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="The lane is quiet. Somewhere ahead, a gate stands open." />
      </Field>
      <Field id="insp-state-arrivelabel" label={<>Arrive label <span className="muted">(what proves you got here — used when a transition names no evidence)</span></>}>
        <TextInput id="insp-state-arrivelabel" value={arriveLabel} onChange={(e) => setArriveLabel(e.target.value)} placeholder="the orchard gate" spellCheck={false} />
      </Field>

      {/* A CAMERA THAT DRIVES ITSELF while the player is here — an orbit, a
          traveling shot. The prose and the channel must agree: an orbit pairs
          strafe with a look the other way, and camera prose that says so. */}
      <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line)' }}>
        <strong style={{ color: 'var(--acc)' }}>Autopilot</strong>
        <p className="muted" style={{ margin: '2px 0 0' }}>Held while the player is in this state, not for one move.</p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Field id="insp-state-auto-move" label="Movement">
            <Select id="insp-state-auto-move" value={autoMove} onChange={(e) => setAutoMove(e.target.value)}>
              <option value="">(none)</option>
              <option value="forward">forward</option>
              <option value="back">back</option>
              <option value="strafe_left">strafe left</option>
              <option value="strafe_right">strafe right</option>
            </Select>
          </Field>
          <Field id="insp-state-auto-lookh" label="Look">
            <Select id="insp-state-auto-lookh" value={autoLookH} onChange={(e) => setAutoLookH(e.target.value)}>
              <option value="">(none)</option>
              <option value="left">left</option>
              <option value="right">right</option>
            </Select>
          </Field>
        </div>
        <Field id="insp-state-auto-keep" label={<>Keep centred <span className="muted">(a detect label; needs a vision provider)</span></>}>
          <TextInput id="insp-state-auto-keep" value={autoKeep} onChange={(e) => setAutoKeep(e.target.value)} placeholder="the stone arch" spellCheck={false} />
        </Field>
      </div>

      {/* A/B PROMPTS. Author an alternate and play each on the SAME entrance
          seed: same picture to start from, different words, so the comparison
          is about the prose and nothing else. */}
      <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line)' }}>
        <div className="row" style={{ alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <strong style={{ color: 'var(--acc)' }}>Prompt A/B</strong>
          <Button variant={arm === null ? 'primary' : 'ghost'} text="A" title="the state's own prompt" onClick={() => selectArm(null)} />
          {pendingVariants.map((v) => (
            <Button
              key={v.label}
              variant={arm === v.label ? 'primary' : 'ghost'}
              text={v.label}
              title={`edit variant ${v.label}`}
              onClick={() => selectArm(v.label)}
            />
          ))}
          <Button
            variant="ghost"
            text="+ variant"
            title="add an alternate prompt to compare against this one"
            onClick={() => {
              const label = String.fromCharCode(66 + pendingVariants.length)
              const seeded: SMPromptVariant = {
                label,
                base: st.base ?? '',
                ...(st.camera ? { camera: st.camera } : {}),
                ...(st.movement ? { movement: st.movement } : {}),
              }
              setPendingVariants([...pendingVariants, seeded])
              setArm(label)
              setBase(seeded.base)
            }}
          />
          {arm !== null && (
            <Button
              variant="ghost"
              text={`delete ${arm}`}
              onClick={() => {
                const next = pendingVariants.filter((v) => v.label !== arm)
                setPendingVariants(next)
                selectArm(null)
              }}
            />
          )}
        </div>
        <p className="muted" style={{ margin: '4px 0 0' }}>
          {arm === null
            ? 'Editing A — the state itself.'
            : `Editing variant ${arm}. Saving writes the variant, not the state.`}
          {' '}
          <a href={`?play=${playWorldId}&state=${stateId}${arm ? `&variant=${arm}` : ''}`}>
            ▶ play {arm ?? 'A'} from here
          </a>
        </p>
      </div>

      <Field id="insp-state-base" label="Base prompt">
        <TextArea id="insp-state-base" value={base} onChange={(e) => setBase(e.target.value)} placeholder="What the camera sees in this state." />
      </Field>

      <Field id="insp-state-cam-static" label="Camera — static">
        <TextInput id="insp-state-cam-static" value={camStatic} onChange={(e) => setCamStatic(e.target.value)} placeholder="framing that holds across the state" spellCheck={false} />
      </Field>
      <Field id="insp-state-cam-dynamic" label="Camera — dynamic">
        <TextInput id="insp-state-cam-dynamic" value={camDynamic} onChange={(e) => setCamDynamic(e.target.value)} placeholder="motion the camera adds" spellCheck={false} />
      </Field>

      <Field id="insp-state-mov-static" label="Movement — static">
        <TextInput id="insp-state-mov-static" value={movStatic} onChange={(e) => setMovStatic(e.target.value)} placeholder="stance / rest pose" spellCheck={false} />
      </Field>
      <Field id="insp-state-mov-dynamic" label="Movement — dynamic">
        <TextInput id="insp-state-mov-dynamic" value={movDynamic} onChange={(e) => setMovDynamic(e.target.value)} placeholder="motion in the scene" spellCheck={false} />
      </Field>

      <Checkbox label="This state is an ending" checked={endingOn} onChange={setEndingOn} />
      {endingOn && (
        <div style={{ marginTop: 4 }}>
          <Field id="insp-state-ending-kind" label="Ending kind">
            <Select id="insp-state-ending-kind" value={endingKind} onChange={(e) => setEndingKind(e.target.value === 'lose' ? 'lose' : 'win')}>
              <option value="win">win</option>
              <option value="lose">lose</option>
            </Select>
          </Field>
          <Field id="insp-state-ending-title" label="Ending title">
            <TextInput id="insp-state-ending-title" value={endingTitle} onChange={(e) => setEndingTitle(e.target.value)} placeholder="e.g. You escaped." spellCheck={false} />
          </Field>
          {/* The form had no subtitle field while the schema and the shipped
              example world both carried one, so pressing Save on a state that
              had a subtitle deleted it — a field you could not see, edit, or
              keep. */}
          <Field id="insp-state-ending-subtitle" label={<>Ending subtitle <span className="muted">(optional)</span></>}>
            <TextInput id="insp-state-ending-subtitle" value={endingSubtitle} onChange={(e) => setEndingSubtitle(e.target.value)} placeholder="e.g. Nothing else needed doing." spellCheck />
          </Field>
        </div>
      )}

      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        <Button variant="primary" busy={busy} text="Save state" onClick={() => { save(); draft.saved() }} />
        <span className={draft.dirty ? 'warn' : 'muted'} style={{ fontSize: 11, alignSelf: 'center' }} data-testid="state-draft">
          {draftLabel(draft.dirty, draft.recovered)}
        </span>
        {draft.recovered && <Button variant="ghost" text="Revert" onClick={draft.revert} />}
        <DangerButton
          text="Delete"
          disabled={busy}
          // Deleting a state cascades: it removes every event that had this as
          // its only `from`, strips it from the others, and clears the world's
          // entrance if it was this one — which leaves a world that cannot be
          // played. Deleting a *world* and pruning a *version* both prompt;
          // the authored content was the one thing that did not.
          confirm={`Delete the state "${stateId}"?\n\nThis also deletes any event that leads only from it, and clears the entrance if it was this state. There is no undo unless you have taken a snapshot.`}
          onClick={onDelete}
        />
      </div>
    </div>
  )
}

function EventForm({ ev, worldId, stateIds, cutsceneIds, mintedFlags, busy, onSave, onDelete }: {
  ev: SMEvent
  /** Scopes the draft: a draft for one world must never restore into another. */
  worldId: string
  stateIds: string[]
  /** Every flag some event in this world GRANTS — the keys that exist, so a
   *  requirement can be picked rather than typed from memory into a doctrine
   *  error. Computed by the caller, which is the part that holds the world. */
  mintedFlags: string[]
  /** Cutscene ids, which a transition may also point at. */
  cutsceneIds: string[]
  busy: boolean
  onSave: (patch: NullablePatch<SMEvent>) => void
  onDelete: () => void
}) {
  const [base, setBase] = useState(ev.base ?? '')
  const [detail, setDetail] = useState(ev.detail ?? '')
  const [hotkey, setHotkey] = useState(ev.hotkey ?? '')
  /** wasd, the arrows and the digits belong to driving and to the beat rail. */
  const hotkeyReserved = RESERVED_HOTKEYS.has(hotkey.trim().toLowerCase())
  const [to, setTo] = useState(ev.to ?? '')
  // ONE-SHOT, which played and had no editor. `legalBeats` drops a `oneShot`
  // beat once it is in `used`, so the mechanic is live in every session — and a
  // human could only ever add it from the CLI or the agent. Same asymmetry as
  // the flag algebra below, one field over.
  const [oneShot, setOneShot] = useState(ev.oneShot === true)
  // THE FLAG ALGEBRA, which had no editor at all. The kernel authors locks in
  // most worlds, the doctrine polices them (`unreachable-require`), and the
  // player renders a padlocked beat with the author's hint — but until now the
  // only ways to add, fix or remove one were the CLI and the agent. A mechanic
  // a human cannot reach in the editor is a recurring pattern, and locks are
  // the version of it a player feels most.
  const [requires, setRequires] = useState((ev.requires ?? []).join(', '))
  const [grants, setGrants] = useState((ev.grants ?? []).join(', '))
  const [lockedHint, setLockedHint] = useState(ev.lockedHint ?? '')
  const unmintedRequires = requires
    .split(',').map((t) => t.trim().replace(/\s+/g, '_')).filter(Boolean)
    .filter((f) => !mintedFlags.includes(f))
  const [label, setLabel] = useState(ev.anchor?.label ?? '')
  const [aliases, setAliases] = useState((ev.anchor?.aliases ?? []).join(', '))
  const [proximity, setProximity] = useState(numStr(ev.anchor?.minProximity))
  // ARRIVAL EVIDENCE and PHASES were authorable by the agent and by the CLI and
  // by nobody with hands. That asymmetry got worse the moment the player began
  // REPLAYING gates over a recorded session (`play/episode.ts`): the studio
  // would tell an author their gate never fired and offer them no way to change
  // it. Three doctrine rules police these fields — `auto-needs-pixels`,
  // `luminance-overlap`, `shared-phase-camera` — and a rule over a field only a
  // machine can write is a rule aimed at a machine.
  const [evNarration, setEvNarration] = useState(ev.narration ?? '')
  const [evCamera, setEvCamera] = useState(ev.camera ?? '')
  const [evMovement, setEvMovement] = useState(ev.movement ?? '')
  const [driveMove, setDriveMove] = useState(ev.drive?.movement ?? '')
  const [driveLookH, setDriveLookH] = useState(ev.drive?.lookHorizontal ?? '')
  const [driveLookV, setDriveLookV] = useState(ev.drive?.lookVertical ?? '')
  const [drivePulse, setDrivePulse] = useState(numStr(ev.drivePulseMs))
  const [wpLabel, setWpLabel] = useState(ev.waypoint?.label ?? '')
  const [wpDistance, setWpDistance] = useState(numStr(ev.waypoint?.distanceM))
  const [minPlay, setMinPlay] = useState(numStr(ev.minPlayMs))
  const [autoAfter, setAutoAfter] = useState(numStr(ev.autoAfterMs))
  const [land, setLand] = useState<SMLandWhen>(ev.landWhen ?? {})
  const [phases, setPhases] = useState<SMEventPhase[]>(ev.phases ?? [])

  const setLandNum = (key: keyof SMLandWhen, raw: string) =>
    setLand((prev) => {
      const next = { ...prev }
      if (raw.trim() === '' || Number.isNaN(Number(raw))) delete next[key]
      else Object.assign(next, { [key]: Number(raw) })
      return next
    })

  // DRAFT — same model as the state form. The event form is the one the
  // doctrine sends people to, so an edit lost here is an edit made twice.
  const fields = JSON.stringify([base, detail, hotkey, to, oneShot, requires, grants, lockedHint, evNarration])
  const loadedFields = JSON.stringify([ev.base ?? '', ev.detail ?? '', ev.hotkey ?? '', ev.to ?? '', ev.oneShot === true, (ev.requires ?? []).join(', '), (ev.grants ?? []).join(', '), ev.lockedHint ?? '', ev.narration ?? ''])
  const draft = useDraft(worldId, `event:${ev.name}`, fields, loadedFields, (raw) => {
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return
    const str = (i: number) => (typeof v[i] === 'string' ? v[i] : '')
    setBase(str(0)); setDetail(str(1)); setHotkey(str(2)); setTo(str(3))
    setOneShot(v[4] === true); setRequires(str(5)); setGrants(str(6)); setLockedHint(str(7)); setEvNarration(str(8))
  })

  function save() {
    const patch: NullablePatch<SMEvent> = {
      base,
      detail,
      hotkey: hotkey.trim() ? hotkey.trim() : null,
    }
    if (to) patch.to = to
    // `false` is ERASED rather than written: an event carrying `oneShot: false`
    // reads as a deliberate statement that it repeats, when it is simply the
    // default — the same rule the lists and the anchor below follow.
    patch.oneShot = oneShot ? true : null
    const tokens = (raw: string): string[] =>
      [...new Set(raw.split(',').map((t) => t.trim().replace(/\s+/g, '_')).filter(Boolean))]
    const req = tokens(requires)
    const grn = tokens(grants)
    // An empty list is ERASED, not written as `[]`: an event carrying an empty
    // `requires` reads as locked-by-nothing everywhere it is inspected.
    patch.requires = req.length ? req : null
    patch.grants = grn.length ? grn : null
    patch.lockedHint = lockedHint.trim() ? lockedHint.trim() : null
    const aliasArr = aliases.split(',').map((s) => s.trim()).filter(Boolean)
    if (label.trim()) {
      const prox = Number(proximity)
      patch.anchor = {
        label: label.trim(),
        ...(aliasArr.length ? { aliases: aliasArr } : {}),
        ...(proximity.trim() !== '' && !Number.isNaN(prox) ? { minProximity: prox } : {}),
      }
    }
    // An empty contract is ERASED rather than written as `{}`: a landWhen with
    // nothing in it can never fire, and leaving one behind would have the
    // player wait out its timeout on every crossing.
    patch.landWhen = Object.keys(land).length ? land : null
    patch.phases = phases.length ? phases : null
    patch.narration = evNarration.trim() ? evNarration : null
    patch.camera = evCamera.trim() ? evCamera : null
    patch.movement = evMovement.trim() ? evMovement : null
    // Narrowed, not asserted: a <select>'s value is a string, and the whole
    // point of the union is that only these words reach the control channel.
    // An assertion here would hand an unknown token to the transport, which
    // throws — at the far end, in a session, instead of in this form.
    const drive: SMDrive = {}
    const move = MOVE_VALUES.find((v) => v === driveMove)
    const lookH = LOOK_H_VALUES.find((v) => v === driveLookH)
    const lookV = LOOK_V_VALUES.find((v) => v === driveLookV)
    if (move) drive.movement = move
    if (lookH) drive.lookHorizontal = lookH
    if (lookV) drive.lookVertical = lookV
    patch.drive = Object.keys(drive).length ? drive : null
    patch.drivePulseMs = drivePulse.trim() && !Number.isNaN(Number(drivePulse)) ? Number(drivePulse) : null
    const wpM = Number(wpDistance)
    patch.waypoint = wpLabel.trim() && wpDistance.trim() && !Number.isNaN(wpM) && wpM > 0
      ? { label: wpLabel.trim(), distanceM: wpM }
      : null
    patch.minPlayMs = minPlay.trim() && !Number.isNaN(Number(minPlay)) ? Number(minPlay) : null
    patch.autoAfterMs = autoAfter.trim() && !Number.isNaN(Number(autoAfter)) ? Number(autoAfter) : null
    onSave(patch)
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>Event <code>{ev.name}</code></strong>
        <Pill>{ev.kind}</Pill>
      </div>
      <p className="muted" style={{ margin: '2px 0 0' }}>from <code>{ev.from.join(', ') || '—'}</code></p>

      <Field id="insp-event-base" label="Base prompt">
        <TextArea id="insp-event-base" value={base} onChange={(e) => setBase(e.target.value)} placeholder="The moment this choice fires." />
      </Field>
      <Field id="insp-event-detail" label={<>Detail <span className="muted">(extra transition prompt)</span></>}>
        <TextArea id="insp-event-detail" value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="How the transition plays out." />
      </Field>

      <Field id="insp-event-hotkey" label={<>Hotkey <span className="muted">(single key; blank = none)</span></>}>
        <TextInput id="insp-event-hotkey" value={hotkey} onChange={(e) => setHotkey(e.target.value)} placeholder="e.g. k" spellCheck={false} maxLength={12} />
      </Field>
      {hotkeyReserved && (
        <p className="diag warning" style={{ marginTop: 4 }}>
          <strong>{hotkey.trim().toLowerCase()}</strong> is a driving control — a player holds it to move, so it
          cannot also fire this beat. Pick another key; this one will be ignored at play time.
        </p>
      )}

      {/* ONE-SHOT sits beside the locks because it is the same kind of statement
          about availability: a lock says "not yet", this says "not again". */}
      <Checkbox
        label="Once only — after it fires, this beat is gone"
        checked={oneShot}
        onChange={setOneShot}
      />

      {/* LOCKS. `grants` mints a flag, `requires` demands one, `lockedHint` is
          what the player is told when they cannot pass. The doctrine refuses a
          requirement no event grants (`unreachable-require`), so the field
          offers the flags this world actually mints rather than a blank box —
          the same correction the agent needed handed back to it live. */}
      <div className="row" style={{ marginTop: 10 }}>
        <strong style={{ fontSize: 12, letterSpacing: 1 }}>LOCKS</strong>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 11 }}>flags this world mints: {mintedFlags.length ? mintedFlags.join(', ') : 'none yet'}</span>
      </div>

      <Field id="insp-event-grants" label={<>Grants <span className="muted">(flags this event hands the player, comma-separated)</span></>}>
        <TextInput id="insp-event-grants" value={grants} onChange={(e) => setGrants(e.target.value)} placeholder="e.g. has_lamp" spellCheck={false} />
      </Field>

      <Field id="insp-event-requires" label={<>Requires <span className="muted">(flags the player must already hold)</span></>}>
        <TextInput id="insp-event-requires" value={requires} onChange={(e) => setRequires(e.target.value)} placeholder="e.g. has_lamp" spellCheck={false} list="insp-minted-flags" />
      </Field>
      <datalist id="insp-minted-flags">
        {mintedFlags.map((f) => <option key={f} value={f} />)}
      </datalist>
      {unmintedRequires.length > 0 && (
        <p className="diag warning" style={{ marginTop: 4 }}>
          Nothing grants <strong>{unmintedRequires.join(', ')}</strong> — a lock with no key can never open, and
          the doctrine will refuse this world. Give some earlier event that flag under <em>Grants</em>.
        </p>
      )}

      <Field id="insp-event-locked-hint" label={<>Locked hint <span className="muted">(what the player reads when it will not open)</span></>}>
        <TextInput id="insp-event-locked-hint" value={lockedHint} onChange={(e) => setLockedHint(e.target.value)} placeholder="The door is locked. Something turns it." spellCheck={false} />
      </Field>
      {requires.trim() !== '' && lockedHint.trim() === '' && (
        <p className="diag" style={{ marginTop: 4 }}>
          Without a hint this beat is <strong>hidden</strong> while it is locked rather than shown greyed out —
          the player never learns it is there. That is a choice, and it is the quieter one.
        </p>
      )}

      {/* A destination is a state OR a cutscene — the runtime resolves cuts
          first, so an author has to be able to name one here. */}
      <Field id="insp-event-to" label="To state">
        <Select id="insp-event-to" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">(none)</option>
          {stateIds.map((s) => <option key={s} value={s}>{s}</option>)}
          {cutsceneIds.map((c) => <option key={`cut:${c}`} value={c}>{c} (cutscene)</option>)}
        </Select>
      </Field>

      {/* Anchor — turns this choice into a clickable in-world object. */}
      <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line)' }}>
        <strong style={{ color: 'var(--acc)' }}>Anchor</strong>
        <p className="muted" style={{ margin: '2px 0 0' }}>The visible object a player clicks to fire this choice.</p>
        <Field id="insp-event-anchor-label" label="Label">
          <TextInput id="insp-event-anchor-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. the vault door" spellCheck={false} />
        </Field>
        <Field id="insp-event-anchor-aliases" label={<>Aliases <span className="muted">(comma-separated)</span></>}>
          <TextInput id="insp-event-anchor-aliases" value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="door, safe, hatch" spellCheck={false} />
        </Field>
        <Field id="insp-event-anchor-proximity" label={<>Min proximity <span className="muted">(0-1 — how big before it is clickable)</span></>}>
          <TextInput id="insp-event-anchor-proximity" value={proximity} onChange={(e) => setProximity(e.target.value)} placeholder="0.12" inputMode="decimal" />
        </Field>
      </div>

      {/* THE EVENT'S OWN SHOT. A state's camera frames standing somewhere; the
          move between two states is a different shot, and an author should not
          have to split a one-beat move into phases to say so. */}
      <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line)' }}>
        <strong style={{ color: 'var(--acc)' }}>While it plays</strong>
        <Field id="insp-event-narration" label={<>Narration <span className="muted">(the outcome the player READS; not sent to the model)</span></>}>
          <TextArea id="insp-event-narration" value={evNarration} onChange={(e) => setEvNarration(e.target.value)} placeholder="You push through the gap. The orchard opens out ahead." />
        </Field>
        <Field id="insp-event-camera" label={<>Camera <span className="muted">(this move's framing)</span></>}>
          <TextInput id="insp-event-camera" value={evCamera} onChange={(e) => setEvCamera(e.target.value)} placeholder="low and close, following through the gap" spellCheck={false} />
        </Field>
        <Field id="insp-event-movement" label={<>Movement <span className="muted">(what the body does)</span></>}>
          <TextInput id="insp-event-movement" value={evMovement} onChange={(e) => setEvMovement(e.target.value)} placeholder="striding forward, one hand out" spellCheck={false} />
        </Field>
        {/* A DESTINATION THE PLAYER DRIVES TO. There is no geometry to measure
            against, so the distance is what they have travelled — hold forward
            and it counts down. Pair with `hidden`: the arrival plays itself. */}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Field id="insp-event-wp-label" label={<>Waypoint <span className="muted">(HUD name)</span></>}>
            <TextInput id="insp-event-wp-label" value={wpLabel} onChange={(e) => setWpLabel(e.target.value)} placeholder="PORT GELLHORN" spellCheck={false} />
          </Field>
          <Field id="insp-event-wp-distance" label={<>Distance <span className="muted">(display metres)</span></>}>
            <TextInput id="insp-event-wp-distance" value={wpDistance} onChange={(e) => setWpDistance(e.target.value)} placeholder="800" inputMode="numeric" />
          </Field>
        </div>

        {/* THE CONTROLS THIS MOVE PRESSES. The model reads the prompt AND the
            control channel, and prose about striding forward over an idle
            channel is a contradiction. */}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Field id="insp-event-drive-move" label={<>Drive <span className="muted">(movement)</span></>}>
            <Select id="insp-event-drive-move" value={driveMove} onChange={(e) => setDriveMove(e.target.value)}>
              <option value="">(none)</option>
              <option value="forward">forward</option>
              <option value="back">back</option>
              <option value="strafe_left">strafe left</option>
              <option value="strafe_right">strafe right</option>
            </Select>
          </Field>
          <Field id="insp-event-drive-lookh" label={<>Look <span className="muted">(horizontal)</span></>}>
            <Select id="insp-event-drive-lookh" value={driveLookH} onChange={(e) => setDriveLookH(e.target.value)}>
              <option value="">(none)</option>
              <option value="left">left</option>
              <option value="right">right</option>
            </Select>
          </Field>
          <Field id="insp-event-drive-lookv" label={<>Look <span className="muted">(vertical)</span></>}>
            <Select id="insp-event-drive-lookv" value={driveLookV} onChange={(e) => setDriveLookV(e.target.value)}>
              <option value="">(none)</option>
              <option value="up">up</option>
              <option value="down">down</option>
            </Select>
          </Field>
          <Field id="insp-event-drive-pulse" label={<>Pulse ms <span className="muted">(blank = hold until it lands)</span></>}>
            <TextInput id="insp-event-drive-pulse" value={drivePulse} onChange={(e) => setDrivePulse(e.target.value)} placeholder="500" inputMode="numeric" />
          </Field>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Field id="insp-event-minplay" label={<>Min play ms <span className="muted">(streams at least this long)</span></>}>
            <TextInput id="insp-event-minplay" value={minPlay} onChange={(e) => setMinPlay(e.target.value)} placeholder="4000" inputMode="numeric" />
          </Field>
          <Field id="insp-event-autoafter" label={<>Auto after ms <span className="muted">(fires itself; pair with hidden)</span></>}>
            <TextInput id="insp-event-autoafter" value={autoAfter} onChange={(e) => setAutoAfter(e.target.value)} placeholder="3500" inputMode="numeric" />
          </Field>
        </div>
      </div>

      {/* ARRIVAL EVIDENCE. What the picture must SHOW before the destination is
          allowed to land — the studio's answer to a world model resolving
          backward when a prompt lands ahead of the pixels. Clauses OR: any one
          of them passing counts as a hit. */}
      <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line)' }}>
        <strong style={{ color: 'var(--acc)' }}>Arrival evidence</strong>
        <p className="muted" style={{ margin: '2px 0 0' }}>
          What the picture must show before this lands. Any one clause passing counts — leave all
          of them blank and the transition lands as soon as it is sent.
        </p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Field id="insp-lw-minlum" label={<>min luminance <span className="muted">(0-255)</span></>}>
            <TextInput id="insp-lw-minlum" value={numStr(land.minLuminance)} onChange={(e) => setLandNum('minLuminance', e.target.value)} placeholder="70" inputMode="numeric" />
          </Field>
          <Field id="insp-lw-maxlum" label={<>max luminance <span className="muted">(0-255)</span></>}>
            <TextInput id="insp-lw-maxlum" value={numStr(land.maxLuminance)} onChange={(e) => setLandNum('maxLuminance', e.target.value)} placeholder="45" inputMode="numeric" />
          </Field>
          <Field id="insp-lw-minmotion" label="min motion">
            <TextInput id="insp-lw-minmotion" value={numStr(land.minMotion)} onChange={(e) => setLandNum('minMotion', e.target.value)} placeholder="18" inputMode="numeric" />
          </Field>
          <Field id="insp-lw-maxmotion" label={<>max motion <span className="muted">(comes to rest)</span></>}>
            <TextInput id="insp-lw-maxmotion" value={numStr(land.maxMotion)} onChange={(e) => setLandNum('maxMotion', e.target.value)} placeholder="12" inputMode="numeric" />
          </Field>
        </div>
        <Field id="insp-lw-label" label={<>label <span className="muted">(costs a vision call — the free clauses above do not)</span></>}>
          <TextInput
            id="insp-lw-label"
            value={land.label ?? ''}
            onChange={(e) => setLand((p) => { const n = { ...p }; if (e.target.value.trim()) n.label = e.target.value; else delete n.label; return n })}
            placeholder="the bench"
            spellCheck={false}
          />
        </Field>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Field id="insp-lw-minextent" label={<>min extent <span className="muted">(0-1)</span></>}>
            <TextInput id="insp-lw-minextent" value={numStr(land.minExtent)} onChange={(e) => setLandNum('minExtent', e.target.value)} placeholder="0.12" inputMode="decimal" />
          </Field>
          <Field id="insp-lw-hits" label={<>hits <span className="muted">(passing ticks needed)</span></>}>
            <TextInput id="insp-lw-hits" value={numStr(land.hits)} onChange={(e) => setLandNum('hits', e.target.value)} placeholder="1" inputMode="numeric" />
          </Field>
          <Field id="insp-lw-timeout" label={<>timeout ms <span className="muted">(fails OPEN)</span></>}>
            <TextInput id="insp-lw-timeout" value={numStr(land.timeoutMs)} onChange={(e) => setLandNum('timeoutMs', e.target.value)} placeholder="20000" inputMode="numeric" />
          </Field>
        </div>
        <Checkbox
          checked={!!land.auto}
          onChange={(on) => setLand((p) => { const n = { ...p }; if (on) n.auto = true; else delete n.auto; return n })}
          label="also fire during free roam (trigger zone)"
        />
      </div>

      {/* PHASES. A move told one beat at a time. When present they REPLACE the
          base above — the runtime streams the beats — so an empty base on a
          phased event is expected, not a bug. */}
      <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line)' }}>
        <strong style={{ color: 'var(--acc)' }}>Phases</strong>
        <p className="muted" style={{ margin: '2px 0 0' }}>
          {phases.length
            ? 'Each beat streams in order for its own time. While phases are set, the base prompt above is not sent.'
            : 'Tell a long move one beat at a time, so the ending cannot land while the pixels still show the beginning.'}
        </p>
        {phases.map((p, i) => (
          <div key={i} style={{ border: '1px solid var(--line)', borderRadius: 6, padding: 8, marginTop: 6 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Pill>beat {i + 1}</Pill>
              <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                <TextInput
                  id={`insp-phase-ms-${i}`}
                  aria-label={`beat ${i + 1} milliseconds`}
                  value={numStr(p.minMs)}
                  onChange={(e) => setPhases((prev) => prev.map((q, k) => (k === i ? withMinMs(q, e.target.value) : q)))}
                  placeholder="5000"
                  inputMode="numeric"
                  style={{ width: 90 }}
                />
                <span className="muted" style={{ fontSize: 11 }}>ms</span>
                <Button variant="ghost" text="✕" title={`remove beat ${i + 1}`} onClick={() => setPhases((prev) => prev.filter((_, k) => k !== i))} />
              </div>
            </div>
            <TextArea
              id={`insp-phase-base-${i}`}
              aria-label={`beat ${i + 1} prompt`}
              value={p.base ?? ''}
              onChange={(e) => setPhases((prev) => prev.map((q, k) => (k === i ? { ...q, base: e.target.value } : q)))}
              placeholder="What the camera sees during this beat."
            />
            <TextInput
              id={`insp-phase-camera-${i}`}
              aria-label={`beat ${i + 1} camera`}
              value={p.camera ?? ''}
              onChange={(e) => setPhases((prev) => prev.map((q, k) => (k === i ? withCamera(q, e.target.value) : q)))}
              placeholder="camera for this beat — each beat needs its own, or the doctrine says so"
              spellCheck={false}
            />
          </div>
        ))}
        <div className="row" style={{ marginTop: 6 }}>
          <Button
            variant="ghost"
            text={phases.length ? '+ add beat' : '+ make this a phased move'}
            onClick={() => setPhases((prev) => [...prev, { base: '', minMs: 5000 }])}
          />
        </div>
      </div>

      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        <Button variant="primary" busy={busy} text="Save event" onClick={() => { save(); draft.saved() }} />
        <span className={draft.dirty ? 'warn' : 'muted'} style={{ fontSize: 11, alignSelf: 'center' }} data-testid="event-draft">
          {draftLabel(draft.dirty, draft.recovered)}
        </span>
        {draft.recovered && <Button variant="ghost" text="Revert" onClick={draft.revert} />}
        <DangerButton
          text="Delete"
          disabled={busy}
          // Deleting an event is not recoverable either, and the button sits
          // 8px from Save.
          confirm={`Delete the event "${ev.name}"?\n\nThere is no undo unless you have taken a snapshot.`}
          onClick={onDelete}
        />
      </div>
    </div>
  )
}

/** Keys the player needs for driving. An authored hotkey may not take one. */
const RESERVED_HOTKEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '])

/** The control grammar, as the only values these selects may produce. */
const MOVE_VALUES = ['forward', 'back', 'strafe_left', 'strafe_right'] as const
const LOOK_H_VALUES = ['left', 'right'] as const
const LOOK_V_VALUES = ['up', 'down'] as const

/** A number as a form value: absent reads as empty, never as "0" or "NaN". */
function numStr(n: number | undefined): string {
  return n == null || Number.isNaN(n) ? '' : String(n)
}

/** Beat timing, erased rather than stored as NaN when the field is cleared. */
function withMinMs(phase: SMEventPhase, raw: string): SMEventPhase {
  const next = { ...phase }
  if (raw.trim() === '' || Number.isNaN(Number(raw))) delete next.minMs
  else next.minMs = Number(raw)
  return next
}

function withCamera(phase: SMEventPhase, raw: string): SMEventPhase {
  const next = { ...phase }
  if (raw.trim() === '') delete next.camera
  else next.camera = raw
  return next
}

function Diags({ items }: { items: Diagnostic[] }) {
  return (
    <div style={{ marginTop: 6 }}>
      {items.map((d, i) => (
        <div key={`${d.lint}:${d.path}:${i}`} className={'diag ' + d.severity}>
          <strong>{d.lint}</strong> <span className="muted">{d.path}</span>
          <div>{d.message}</div>
        </div>
      ))}
    </div>
  )
}
