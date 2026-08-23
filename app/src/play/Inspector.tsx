import { useMemo } from 'react'
import type { SMEvent, SMLandWhen, SMState } from '../world'
import { PROMPT_BUDGET } from '../world'
import { Button, Pill } from '../theme'
import { driftNote } from './episode'

interface InspectorProps {
  states: Record<string, SMState>
  events: SMEvent[]
  currentState: string | null
  /** Every state entered this session, in order — the trail, not the graph. */
  trail: string[]
  /** A drive key is down: the runtime is on the DYNAMIC layer variants. */
  moving: boolean
  /** A look key is down — the camera is turning. */
  looking?: boolean | undefined
  /** A beat is in flight. */
  sending: string | null
  /** …and what it is doing: which phase, or what evidence it is waiting for. */
  sendingNote?: string | null | undefined
  probing: boolean
  paused: boolean
  onPause: () => void
  onJump: (stateId: string) => void
  onTake: (event: SMEvent) => void
  onHide: () => void
  disabled: boolean
  /** How much of this session has been recorded — the provenance of every gate
   *  verdict. A verdict over an empty record looks identical to one over a real
   *  session, so the size is shown beside them. */
  episode?: { frames: number; detects: number } | undefined
  /** Replay an authored gate over what this session actually showed. Returns
   *  null when there is no record yet. */
  replay?:
    | ((
        when: SMLandWhen,
        eventName: string,
      ) => { passed: boolean; firedAtMs: number | null; hits: number; groundable: boolean; ran: boolean } | null)
    | undefined
}

/**
 * The play-time inspector — the state machine's traversal over the EXACT prompt
 * being streamed, so an author can watch what is sent while they play.
 *
 * Four fixed sections in a fixed order — TIMELINE, STATE GRAPH, BRANCHES,
 * PROMPT → MODEL — and a char count kept against the kernel's 1900-character
 * budget, which is the number the `budget` doctrine lint enforces at
 * authoring time. Watching a world play without it means guessing which
 * layer the runtime resolved.
 *
 * Three deliberate design choices, each because the capability behind it
 * differs rather than for taste:
 *
 *   · STATE GRAPH is a pill map, not a mini node graph. It answers the
 *     question the section exists for (where am I in the world, how much of it
 *     have I seen) at 340px without a second graph renderer.
 *   · PAUSE freezes DETECTION, not the stream. The studio's provider contract
 *     has no pause, and a button labelled pause that leaves the picture moving
 *     would be a lie. Frozen chips are the useful half anyway: it is what lets
 *     you read one.
 *   · The register chips are MOVE, LOOK and SEND — no SPRINT, which the studio
 *     has no channel for. LOOK earned its place the hard way: the arrows used to
 *     strafe, so a chip reading "turn to face" asked for a control the player did
 *     not have, and 91 seconds of pressing them on a live session never armed it.
 */
export function PlayInspector({
  states, events, currentState, trail, moving, looking, sending, sendingNote, probing, paused,
  onPause, onJump, onTake, onHide, disabled, replay, episode,
}: InspectorProps) {
  const state = currentState ? states[currentState] : undefined
  const ids = Object.keys(states)
  const seen = new Set(trail)

  // Which layer variant the runtime is on right now: camera goes dynamic on
  // move OR look, movement only on move.
  const cameraVariant: 'static' | 'dynamic' = moving || looking ? 'dynamic' : 'static'
  const variant: 'static' | 'dynamic' = moving ? 'dynamic' : 'static'

  const layers = useMemo(() => {
    if (!state) return []
    const out: { label: string; text: string }[] = [{ label: 'BASE', text: state.base }]
    if (state.camera) out.push({ label: `CAMERA · ${cameraVariant}`, text: state.camera[cameraVariant] })
    if (state.movement) out.push({ label: `MOVEMENT · ${variant}`, text: state.movement[variant] })
    return out
  }, [state, variant, cameraVariant])

  // AMBIENT is authored and NOT SENT. It used to sit in `layers`, which made
  // this panel — the one place an author checks what the model receives — count
  // it into the budget and present it as part of the prompt. Nothing sends it:
  // `readOpening` streams `entrance.base` alone and `promptForBeat` is base +
  // camera + movement. Ambient is designed as a MECHANIC (a random line from
  // the pool rides the stream for ~7s at an 8-20s cadence, never during an
  // event); this codebase has the field, the kernel that fills it, and no
  // consumer. Shown separately, plainly labelled, until that mechanic exists.
  const ambient = state?.ambient?.length ? state.ambient : null

  const assembled = layers.map((l) => l.text).filter(Boolean).join(' ')
  const over = assembled.length > PROMPT_BUDGET

  const branches = events.filter(
    (e) => !e.hidden && (e.from.length === 0 || (currentState !== null && e.from.includes(currentState))),
  )

  return (
    <div className="playspect">
      <div className="playspect-head">
        <Button
          className={paused ? 'playspect-btn on' : 'playspect-btn'}
          onClick={onPause}
          title={paused ? 'resume detection' : 'freeze detection to inspect this moment'}
          text={paused ? '▶ resume' : '⏸ pause'}
        />
        {probing && !paused && <span className="playspect-probing" title="a detection is in flight">◍</span>}
        <span className="spacer" />
        <Button className="playspect-btn" onClick={onHide} title="hide the inspector" text="×" />
      </div>

      <div className="playspect-section">
        <div className="playspect-label">timeline{trail.length > 1 ? ` · ${trail.length} nodes` : ''}</div>
        <div className="playspect-trail">
          {trail.length === 0 && <span className="muted">— not started —</span>}
          {trail.map((id, i) => (
            <Button
              key={`${id}:${i}`}
              className={id === currentState && i === trail.length - 1 ? 'playspect-node on' : 'playspect-node'}
              style={{ marginLeft: i === 0 ? 0 : 10 }}
              onClick={() => onJump(id)}
              disabled={disabled}
              title={`jump back to ${id}`}
              text={`${i === 0 ? '' : '└ '}${id}`}
            />
          ))}
        </div>
      </div>

      <div className="playspect-section">
        <div className="playspect-label">
          state graph <Pill>{Math.max(1, seen.size)}/{ids.length}</Pill>
        </div>
        <div className="playspect-map">
          {ids.map((id) => (
            <span
              key={id}
              className={
                id === currentState ? 'playspect-dot on' : seen.has(id) ? 'playspect-dot seen' : 'playspect-dot'
              }
              title={id}
            >
              {id}
            </span>
          ))}
        </div>
      </div>

      <div className="playspect-section">
        <div className="playspect-label">
          branches{branches.length === 0 ? ' — none (terminal)' : ''}
          {episode && (
            <span className="playspect-episode">
              episode · {episode.frames} frame{episode.frames === 1 ? '' : 's'} · {episode.detects} detect{episode.detects === 1 ? '' : 's'}
            </span>
          )}
          {episode && driftNote(episode.frames) && (
            <span className="playspect-episode" title="measured on an idle session — see SESSION_DRIFT">
              {driftNote(episode.frames)}
            </span>
          )}
        </div>
        {branches.map((e) => {
          // EVIDENCE, REPLAYED. A gate is a claim about what the picture will
          // show; this says whether it ever did during this session, and when.
          // The alternative — an author staring at prose wondering whether
          // `minLuminance: 70` was reachable in their own world — is the state
          // this codebase was in until the episode record existed.
          const verdict = e.landWhen && replay ? replay(e.landWhen, e.name) : null
          return (
            <Button
              key={e.name}
              className={e.kind === 'terminal' ? 'playspect-branch terminal' : 'playspect-branch'}
              onClick={() => onTake(e)}
              disabled={disabled || !!sending}
              title={e.to ? `take "${e.name}" → ${e.to}` : `${e.name} — recolours this state`}
            >
              {e.name}
              {e.to && <span className="muted"> → {e.to}</span>}
              {verdict && (
                <span
                  className={verdict.passed ? 'gate-hit' : 'gate-miss'}
                  title={
                    verdict.ran
                      ? 'measured from the moment this gate actually started watching'
                      : 'this gate has not run yet — replayed from when you entered this state, so it is what WOULD have happened'
                  }
                >
                  {!verdict.groundable
                    ? ' ○ nothing to ground'
                    : verdict.passed
                      ? ` ${verdict.ran ? '✓' : '≈'} ${((verdict.firedAtMs ?? 0) / 1000).toFixed(1)}s`
                      : ` ${verdict.ran ? '✕' : '≈'} ${verdict.hits} hit${verdict.hits === 1 ? '' : 's'}`}
                </span>
              )}
            </Button>
          )
        })}
      </div>

      <div className="playspect-section grow">
        <div className="playspect-label">
          prompt → model
          {paused && <span className="playspect-paused"> ⏸ paused</span>}
          <span className={over ? 'playspect-count over' : 'playspect-count'}>
            {assembled.length}/{PROMPT_BUDGET}
          </span>
        </div>
        <div className="playspect-context">
          <span className="playspect-state">{currentState ?? '—'}</span>
          {sending && <span className="playspect-event">▸ {sendingNote ?? sending}</span>}
        </div>
        <div className="playspect-chips">
          <span className={moving ? 'playspect-reg on' : 'playspect-reg'}>MOVE</span>
          <span className={looking ? 'playspect-reg on' : 'playspect-reg'}>LOOK</span>
          <span className={sending ? 'playspect-reg on' : 'playspect-reg'}>SEND</span>
        </div>
        <div className="playspect-layers">
          {layers.length === 0 ? (
            <span className="muted">— booting —</span>
          ) : (
            layers.map((l) => (
              <div key={l.label} className="playspect-layer">
                <div className="playspect-layer-label">{l.label}</div>
                <div className="playspect-layer-text">{l.text}</div>
              </div>
            ))
          )}
          {ambient && (
            <div className="playspect-layer" data-testid="playspect-ambient">
              <div className="playspect-layer-label">AMBIENT · authored, not sent</div>
              <div className="playspect-layer-text muted">
                {ambient.join(' ')}
                <div style={{ marginTop: 4, fontSize: 11 }}>
                  Nothing streams these yet — they are stored on the state and no code reads them.
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
