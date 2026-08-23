import { useCallback, useEffect, useRef, useState } from 'react'
import { useClient } from '../../studio'
import { getLLMProvider } from '../../provider'
import { runLocalEdit, LocalEditError } from './edit'
import type { EditorPanelProps } from '../types'
import { toApiFailure } from '../../world'
import { Button, TextArea } from '../../theme'

/**
 * The kernel agent, floating over the graph.
 *
 * The floating card follows a fixed geometry: 448px card, bottom-center,
 * radius 20, blur(24px), the six-layer elevation, input on top with the
 * action row beneath, a 34px circular send, and the turns stacked as bubbles
 * ABOVE the card. Three views over ONE conversation — `bar` (the resting
 * pill), `popup` (the composer), `panel` (docked history) — because they are
 * the same thread seen at three sizes, not three features.
 *
 * The studio used to reach the agent through a sidebar TAB. That is a
 * different product gesture: a tab is somewhere you navigate to, and it made
 * the agent feel like a panel of the tool rather than someone working the
 * canvas beside you. This is the only agent surface now, and it drives the
 * same `runLocalEdit` the tab did.
 *
 * Two deliberate choices: colour comes from the theme's glass tokens rather
 * than a hardcoded literal (a hardcoded dark card would be an island on the
 * light theme), and the motion is CSS keyframes rather than motion/react —
 * this studio already ships three runtime dependencies and a floating card
 * does not justify a fourth.
 */

type View = 'bar' | 'popup' | 'panel'

interface Turn {
  role: 'user' | 'assistant'
  content: string
}

const PLACEHOLDER = 'tell the agent what to change…'
const EMPTY_HINT =
  'Describe a change in plain language.\n\n"add a losing ending if the player opens the red door"\n"give the guard state a suspicious camera pan"\n\nRejected edits change nothing — the doctrine is the guardrail.'
/** Cap: two diagnostics in the status line, the rest live in the lints panel. */
const STATUS_DIAGS = 2

// The panel bag, NARROWED to what this component reads. It used to take the
// whole `EditorPanelProps` and ignore `world`/`selected`/`select`, which is
// only harmless while the editor is the sole caller: play/ mounts the same
// composer and has no selection to hand it. A component that asks for a
// selection it never reads is a component you cannot reuse.
export function AgentBar({ worldId, rev, reload, toast, startCollapsed = false, onSubmit, label: labelOverride }: Pick<EditorPanelProps, 'worldId' | 'rev' | 'reload' | 'toast'> & {
  /** Open as the pill rather than the composer, because something underneath
   *  needs reading. See `view`'s initial state. */
  startCollapsed?: boolean
  /** Route what was typed somewhere ELSE, and show what comes back.
   *
   *  This is how one chat gets reused for two jobs: during play, this
   *  component takes the director's `submitAction` as its `onSubmit`, so
   *  typing while you are IN the world stages an action instead of editing a
   *  graph you are not looking at. Same conversation, same composer,
   *  different destination — which is why the director did not need a second
   *  chat surface here either. The callback owns its own reloading and
   *  notifications; this component only carries the words. */
  onSubmit?: ((text: string) => Promise<string>) | undefined
  /** What the collapsed pill says, when it is not editing a graph. */
  label?: string | undefined
}) {
  const { client, store, providers, tools } = useClient()
  const llm = getLLMProvider(providers)
  const local = llm.isConfigured()
  const hostedKey = !!providers.world.alakazam.apiKey
  const ready = local || hostedKey

  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  // Open by default (`useState<View>('popup')`). The bar is where the
  // conversation RESTS, not where it starts: an editor that opens with the
  // composer already showing says the agent is part of authoring, and one
  // that opens collapsed says it is a feature you may go and find.
  //
  // …EXCEPT over a world with doctrine lints. The 448px card clears a full
  // window fine, but this editor gives 360px to the inspector, and at that
  // width the card lands squarely on top of the lints — which an e2e caught
  // by failing to click one. A composer never opens on top of something the
  // author needs to read.
  const [view, setView] = useState<View>(startCollapsed ? 'bar' : 'popup')

  // The world moves under us between sends (reload() refreshes rev), so read
  // the live value at send time rather than closing over the render's copy.
  const revRef = useRef(rev)
  revRef.current = rev

  /** Land the log at the newest message when it attaches AND as turns arrive. */
  const logRef = useRef<HTMLDivElement | null>(null)
  const attachLog = useCallback((el: HTMLDivElement | null) => {
    logRef.current = el
    if (el) el.scrollTop = el.scrollHeight
  }, [])
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, busy])

  // Grow with the text up to a 168px ceiling — a scrollbar inside a two-line
  // box is what makes a composer read as a form field.
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const grow = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`
  }, [])
  const attachTa = useCallback(
    (el: HTMLTextAreaElement | null) => {
      taRef.current = el
      grow(el)
      if (el) el.focus()
    },
    [grow],
  )

  // Click anywhere outside the open surface and it collapses back to the bar —
  // there is no close button because the bar is the home you return to.
  // Capture phase: the canvas swallows pointer events on its own nodes, and a
  // bubble-phase listener would never hear those clicks.
  const floatRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (view === 'bar') return
    const onDown = (e: Event) => {
      const target = e.target
      if (!(target instanceof Node)) return
      if (floatRef.current && !floatRef.current.contains(target)) setView('bar')
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [view])

  async function send() {
    const msg = input.trim()
    if (!msg || busy || !ready) return
    setInput('')
    if (taRef.current) taRef.current.style.height = 'auto'
    setBusy(true)
    setTurns((t) => [...t, { role: 'user', content: msg }])
    try {
      if (onSubmit) {
        const line = await onSubmit(msg)
        setTurns((t) => [...t, { role: 'assistant', content: line || '(nothing came back)' }])
        return
      }
      const res = local
        ? await runLocalEdit({ llm, store, tools, worldId, rev: revRef.current, instruction: msg })
        : await hostedEdit(msg)
      if (res.applied > 0) {
        await reload()
        toast(`applied ${res.applied} change${res.applied === 1 ? '' : 's'}`)
      } else {
        // Nothing was written. Saying "applied" over an unchanged graph is the
        // lie this whole surface exists to avoid.
        toast('no change', true)
      }
      const status =
        res.applied > 0
          ? `✓ applied ${res.applied} change${res.applied === 1 ? '' : 's'} to the graph`
          : '(no change made)'
      const lints = res.diagnostics
        .slice(0, STATUS_DIAGS)
        .map((d) => `[${d.lint}] ${d.message}`)
        .join(' · ')
      setTurns((t) => [...t, { role: 'assistant', content: [res.reply, lints, status].filter(Boolean).join('\n') }])
    } catch (e) {
      setTurns((t) => [...t, { role: 'assistant', content: `⚠ ${describe(e)}` }])
      if (isConflict(e)) {
        await reload()
        toast('reload & retry', true)
      }
    } finally {
      setBusy(false)
      // A reply that lands while the surface is minimised reopens it — the
      // answer arrives where the question was asked.
      setView((v) => (v === 'bar' ? 'popup' : v))
    }
  }

  /** The hosted agent, shaped like the local one so `send` has one path. */
  async function hostedEdit(instruction: string) {
    const res = await client.edit(worldId, instruction, revRef.current)
    // The hosted endpoint returns the world it wrote, not a count; a 200 means
    // it applied, so report one change rather than inventing a number.
    return { reply: res.reply, diagnostics: res.diagnostics ?? [], applied: 1 }
  }

  const userTurns = turns.filter((t) => t.role === 'user').length
  const label = ready ? (labelOverride ?? 'ask the kernel agent') : 'no language model configured'

  // Plain functions, not components: a nested component identity changes every
  // render and the textarea would lose focus on each keystroke.
  const bubbles = () => (
    <>
      {turns.map((t, i) => (
        <div key={i} className={`agent-bubble ${t.role === 'user' ? 'user' : 'bot'}`}>
          {t.content}
        </div>
      ))}
      {busy && <div className="agent-bubble bot">…thinking</div>}
    </>
  )

  const textarea = () => (
    <TextArea
      ref={attachTa}
      id="agent-instruction"
      className="agent-prompt"
      rows={1}
      value={input}
      placeholder={ready ? PLACEHOLDER : 'add a language model in Settings to edit by conversation…'}
      disabled={!ready}
      spellCheck={false}
      aria-label="Instruction for the kernel agent"
      onChange={(e) => {
        setInput(e.target.value)
        grow(e.target)
      }}
      onKeyDown={(e) => {
        // The editor listens for its own keys on the canvas; while you are
        // typing here they are yours, not its.
        e.stopPropagation()
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          void send()
        }
      }}
    />
  )

  const sendBtn = () => (
    <Button
      variant="primary"
      className="agent-send"
      onClick={() => void send()}
      disabled={busy || !input.trim() || !ready}
      title={ready ? 'send (Enter)' : 'Configure a language model in Settings — any OpenAI-compatible endpoint, including a local one.'}
      aria-label="Send to the kernel agent"
    >
      <SendIcon busy={busy} />
    </Button>
  )

  if (view === 'panel') {
    return (
      <div className="agent-panel" ref={floatRef}>
        <div className="agent-panel-head">
          <span className="agent-panel-title">
            <span className="agent-dot" />
            KERNEL AGENT
          </span>
          <div className="agent-left">
            <Button className="agent-ghost" onClick={() => setView('popup')} title="undock — float as the bottom composer" text="⊡ float" />
            <Button className="agent-ghost" onClick={() => setView('bar')} title="collapse to the bar" text="✕" />
          </div>
        </div>
        <div className="agent-panel-log" ref={attachLog}>
          {turns.length === 0 ? <div className="agent-hint">{EMPTY_HINT}</div> : bubbles()}
        </div>
        <div className="agent-panel-composer">
          {textarea()}
          {sendBtn()}
        </div>
      </div>
    )
  }

  return (
    <div className={`agent-float${view === 'popup' ? ' popup' : ''}`} ref={floatRef}>
      {view === 'bar' && (
        <div className={`agent-pill${busy ? ' agent-working' : ''}`}>
          <Button className="agent-icon" onClick={() => setView('panel')} title="history">
            ⊟{userTurns > 0 && <span className="agent-count">{userTurns}</span>}
          </Button>
          <div className="agent-sep" />
          <Button onClick={() => setView('popup')} title={label}>
            <span className="agent-dot" />
            {label}
          </Button>
        </div>
      )}

      {view === 'popup' && (
        <>
          {turns.length > 0 && (
            <div className="agent-column" ref={attachLog}>
              {bubbles()}
            </div>
          )}
          <div className={`agent-card${busy ? ' agent-working' : ''}`}>
            {textarea()}
            <div className="agent-row">
              <div className="agent-left">
                {/* The minified state, reachable ON PURPOSE. Collapsing only on
                    a click outside works fine over a full-window canvas; here
                    the click that collapses it usually also selects a node, so
                    "get it out of my way" needed a control of its own. */}
                <Button className="agent-ghost" onClick={() => setView('bar')} title="minimise to the bar" aria-label="Minimise the composer" text="—" />
                <Button className="agent-ghost" onClick={() => setView('panel')} title="open the full history" text="⊟ history" />
                <span className="muted" style={{ fontSize: 11 }}>
                  {local ? `runs on ${llm.label}` : hostedKey ? 'runs on the hosted agent' : 'set a model in Settings'}
                </span>
              </div>
              <div className="agent-right">{sendBtn()}</div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/** The send glyph: an arrow at rest, a spinner while the kernel is thinking. */
function SendIcon({ busy }: { busy: boolean }) {
  if (busy) {
    return (
      <svg className="spin-svg" width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 19V5M12 5l-7 7M12 5l7 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** One sentence a person can act on, whichever layer refused. */
function describe(e: unknown): string {
  if (e instanceof LocalEditError) {
    // Fail-closed: the doctrine rejected the edit and the graph is untouched.
    return `rejected — ${e.message}`
  }
  const f = toApiFailure(e)
  if (f.status === 409) return 'someone else wrote first — reloaded; try again'
  if (f.status === 422) return `rejected — ${f.detail || 'the agent could not make that change safely'}`
  return f.detail || 'the agent edit failed'
}

function isConflict(e: unknown): boolean {
  return !(e instanceof LocalEditError) && toApiFailure(e).status === 409
}
