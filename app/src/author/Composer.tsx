import { useEffect, useRef, useState } from 'react'
import { CHAPTER_MIN_CHARS } from './agent/chapter'
import { useComposer, PREMISE_POOL } from './useComposer'
import type { ComposerViewModel } from './useComposer'
import { Button, Spinner, TextArea } from '../theme'

export interface ComposerProps {
  onCreated: (worldId: string) => void
  /** Renders the × that collapses the card back to the pill. */
  onDismiss?: (() => void) | undefined
  /** The pill's dice pick, filled in before mount. */
  initialPremise?: string | undefined
}

/**
 * The create surface — one card, floating over whatever you are looking at.
 *
 * Every property below was chosen deliberately, not implied by a screenshot.
 * Together they are what makes this read as a FORM rather than a console:
 *
 *   · the prompt is a BORDERLESS auto-growing textarea with no label — you type
 *     into the card, you do not fill in a field;
 *   · one footer row: attach on the left, Cancel/Generate on the right;
 *   · the close is a small circle sitting OUTSIDE the card's top-right corner;
 *   · the card is 560px centred on the VIEWPORT over a blurred scrim, not
 *     tucked into a column of the shell;
 *   · while the kernel works the border BREATHES and the layout holds still,
 *     with a stage line naming the step in the pipeline's own terms.
 *
 * It briefly had a second, full-page chrome for `?section=create`. That was a
 * destination you navigated to in order to start, which is not the gesture this
 * product makes, so there is deliberately no dedicated create page. Deleted;
 * the URL still means something, it just opens this expanded.
 *
 * All state lives in `useComposer`, so the honest failure/retry paths and the
 * "no language model configured" notice behave the same wherever it is opened.
 */
export function Composer({ onCreated, onDismiss, initialPremise }: ComposerProps) {
  const vm = useComposer({ onCreated, initialPremise })
  return <ComposerCard vm={vm} onDismiss={onDismiss} />
}

/** Four of the pool, chosen once per mount. */
function pickFour(): string[] {
  const pool = [...PREMISE_POOL]
  const out: string[] = []
  while (out.length < 4 && pool.length > 0) {
    const i = Math.floor(Math.random() * pool.length)
    const [taken] = pool.splice(i, 1)
    if (taken !== undefined) out.push(taken)
  }
  return out
}

function ComposerCard({ vm, onDismiss }: { vm: ComposerViewModel; onDismiss?: (() => void) | undefined }) {
  const [suggestions] = useState(pickFour)
  const [typed, setTyped] = useState(suggestions[0] ?? '')
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  // Grow with the text, up to a 140px ceiling. A scrollbar inside a two-line box
  // is half of what makes a composer feel like a form.
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [vm.premise])

  /**
   * The placeholder types itself, cycling the pool while the box is empty and
   * idle, at 30ms a character with a 1.9s hold and a quicker erase. It stops
   * the moment there is anything to say, and never starts for a reader who
   * asked for less motion.
   */
  useEffect(() => {
    if (vm.premise !== '' || vm.working) return
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let cancelled = false
    let i = 0
    let ch = 0
    let dir: 'type' | 'hold' | 'erase' = 'type'
    let timer = 0
    const tick = (): void => {
      if (cancelled) return
      const full = suggestions[i % suggestions.length] ?? ''
      if (dir === 'type') {
        ch += 1
        setTyped(full.slice(0, ch))
        if (ch >= full.length) { dir = 'hold'; timer = window.setTimeout(tick, 1900); return }
        timer = window.setTimeout(tick, 30)
      } else if (dir === 'hold') {
        dir = 'erase'
        timer = window.setTimeout(tick, 280)
      } else {
        ch -= 1
        setTyped(full.slice(0, Math.max(0, ch)))
        if (ch <= 0) { dir = 'type'; i += 1; timer = window.setTimeout(tick, 240); return }
        timer = window.setTimeout(tick, 14)
      }
    }
    timer = window.setTimeout(tick, 500)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [vm.premise, vm.working, suggestions])

  // What the kernel is doing, in the pipeline's OWN words when it is talking
  // (paint → probe → author → check, each named as it starts), falling back to
  // the coarse phase before the first note arrives. One line for the whole
  // minute was the old behaviour, and it hid the entire middle of the pipeline.
  const stage =
    vm.stage ||
    (vm.authoring
      ? 'Authoring the world…'
      : vm.seeding
        ? 'Painting the first frame…'
        : vm.creating
          ? 'Creating the world…'
          : '')

  const placeholder = vm.seed
    ? 'Add direction (optional) — or just generate from the frame…'
    : typed || suggestions[0] || 'What is this world about?'

  return (
    <div className="composer-card">
      {onDismiss && (
        <Button
          variant="ghost"
          className="composer-close"
          onClick={onDismiss}
          disabled={vm.working}
          aria-label="Close the composer"
          text="×"
        />
      )}

      <div className={'composer' + (vm.working ? ' busy' : '')}>
        {/* No label and no border: you type INTO the card. The theme's TextArea
            forwards its ref so this can grow with the text — the reason that
            capability was added rather than reaching for a raw element. */}
        <TextArea
          ref={taRef}
          id="composer-premise"
          className="composer-prompt"
          value={vm.premise}
          onChange={(e) => vm.setPremise(e.target.value)}
          placeholder={placeholder}
          disabled={vm.working}
          spellCheck={false}
          rows={1}
          aria-label="Premise"
        />

        {/* SAY WHAT IT WILL DO. The composer routes on length — paste a chapter
            and the world follows its beats instead of the sentence — and a mode
            that switches without telling you is a surprise the first time and a
            bug report the second. It appears only once the text is long enough,
            so a short premise never sees it. */}
        {vm.trimmed.length >= CHAPTER_MIN_CHARS && !vm.working && (
          <p className="muted" style={{ margin: '4px 2px 0', fontSize: 12 }}>
            That is long enough to read as prose, so it will be treated as a{' '}
            <strong>chapter</strong>: the beats it already has become the world's states,
            in the order you wrote them.
          </p>
        )}

        <div className="composer-footer">
          <div className="composer-footer-left">
            <Button
              variant="ghost"
              className="composer-attach"
              onClick={vm.paintSeed}
              disabled={!vm.trimmed || vm.working || !vm.canPaint}
              title={vm.canPaint ? undefined : 'add a Gemini key in Settings (Seed images), or an Alakazam key — painting needs one of them'}
            >
              {vm.seeding ? <><Spinner /> Framing…</> : (vm.seed ? '🖼 Frame ✓' : '+ Frame')}
            </Button>
            {/* QUEST. Not a longer premise — a different product: the frame is
                probed and every objective must name something the detector
                really found, so an action on an undetectable object never
                reaches the player. This path existed before the studio had a
                door to it; it does now. Disabled without an eye, saying which
                key is missing, because offering it would promise a grounding
                the tool refuses to fake. */}
            <Button
              variant="ghost"
              className="composer-attach"
              aria-pressed={vm.quest}
              onClick={() => vm.setQuest(!vm.quest)}
              disabled={vm.working || !vm.canProbe}
              title={vm.canProbe ? 'author a mission grounded on what the detector finds in the frame' : 'a grounded quest needs a seed image AND a vision model — add a Gemini key and a Moondream key in Settings'}
            >
              {vm.quest ? '◆ Quest ✓' : '◆ Quest'}
            </Button>
            {/* The keyless on-ramp: the one thing here that works with no key,
                no model and no network, so it stays one click away. */}
            <Button
              variant="ghost"
              className="composer-attach"
              onClick={() => vm.startExample('starter')}
              disabled={vm.working}
              text="Open the example world"
            />
            {/* The second worked example. A graph is one thing to take apart; a
                MISSION — ordered objectives that compiled themselves into that
                graph, with a grounded step and a way to get it wrong — is the
                other, and it is the one nobody would guess exists. */}
            <Button
              variant="ghost"
              className="composer-attach"
              onClick={() => vm.startExample('quest')}
              disabled={vm.working}
              text="Open the quest example"
            />
          </div>

          <div className="composer-footer-right">
            {vm.working && onDismiss && (
              <Button variant="ghost" className="composer-cancel" onClick={onDismiss} text="Cancel" />
            )}
            <Button
              variant="primary"
              className="composer-send"
              onClick={vm.startCreate}
              disabled={!vm.trimmed || vm.working}
            >
              {vm.working ? <><Spinner /> Generating…</> : '↑ Generate'}
            </Button>
          </div>
        </div>

        {stage !== '' && <div className="composer-status">{stage}</div>}

        {!vm.working && vm.premise === '' && (
          <div className="composer-suggest">
            <span className="composer-try-label">TRY</span>
            <div className="composer-chips">
              {suggestions.map((p) => (
                <Button
                  key={p}
                  variant="ghost"
                  className="composer-chip"
                  onClick={() => vm.setPremise(p)}
                  title={p}
                  text={p}
                />
              ))}
            </div>
          </div>
        )}

        {!vm.working && vm.isLocal && vm.llmLabel === '' && (
          <div className="muted" style={{ fontSize: 11 }}>
            No language model configured — this creates a single opening state. Add one in Settings to author a full graph.
          </div>
        )}

        {vm.error !== null && (
          <div className="diag error">
            {vm.error}
            <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <Button variant="ghost" onClick={vm.retry} text="Try authoring again" />
              {vm.failedWorldId !== null && (
                <Button variant="ghost" onClick={vm.openFailed} text="Open the world as-is" />
              )}
            </div>
          </div>
        )}

        {vm.generated !== null && (
          <div className="diag info">
            {vm.generated.reply}
            <div className="muted" style={{ marginTop: 4 }}>
              {vm.generated.states} states · {vm.generated.events} events
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
