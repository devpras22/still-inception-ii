/**
 * Theme — the studio's one component vocabulary.
 *
 * There is exactly one set of these and it lives here. Domain views compose
 * them; they never reimplement them and never hand-roll an interactive element
 * with the same class names. The moment two views need the same treatment, it
 * moves into this file — a bespoke button in a feature directory is how a design
 * system ends up with four buttons that are almost the same.
 *
 * Belongs here: anything visual with no domain meaning — buttons, cards,
 * diagnostics, spinners, labelled fields and inputs (text, select, checkbox —
 * TextArea forwards its ref, so a caller that must MEASURE the control still
 * goes through the vocabulary instead of reaching for a raw element), the
 * console-frame corner-bracket decoration, and the one transient toast.
 * Two components left this vocabulary because nothing composed them: a `Card`
 * wrapper every domain had already inlined, and a `ConsoleFrame` with no
 * console. A vocabulary is only shared if it is spoken.
 * Belongs elsewhere: anything that knows what a world, a provider or a session
 * is. A component that takes a `WorldListItem` is a world component, however
 * generic it looks.
 *
 * PROPS OVER CHILDREN for buttons. `text`, `busy` and `variant` compose into the
 * standard layout with the spinner in the right place and the disabled state
 * handled; passing children bypasses all of that. Children remain available for
 * the genuinely irregular cases, which should stay rare.
 *
 * The classes themselves are defined in ./styles.css. Colour comes from CSS
 * variables there and never from a literal in a component, so a component never
 * knows which theme it is in.
 *
 * The theme domain also owns WHICH theme is active: the `ThemeName` vocabulary,
 * the localStorage slot it persists in, and `applyTheme` — the one place the
 * `data-theme` attribute is written. Everything else (the URL parameter, the
 * toggle) hands a name to these; no component ever reads one.
 */

import { forwardRef, useCallback, useEffect, useState } from 'react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'

// ── Theme state ──────────────────────────────────────────────────────────────

export type ThemeName = 'dark' | 'light'

/** Where the chosen theme persists. Versioned like every other storage slot. */
export const THEME_STORAGE_KEY = 'alakazam-studio:theme:v1'

export function isThemeName(v: unknown): v is ThemeName {
  return v === 'dark' || v === 'light'
}

/** The persisted choice, or null when the user has never chosen. */
export function readStoredTheme(): ThemeName | null {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY)
    return isThemeName(v) ? v : null
  } catch {
    return null // storage disabled — every visit starts on the default
  }
}

export function writeStoredTheme(theme: ThemeName): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Storage refused; the choice still applies for this tab via applyTheme.
  }
}

/**
 * Stamp the theme on the document. Dark is the bare `:root` default, so the
 * attribute could be omitted for it — it is stamped anyway so "what theme am I
 * in" always has one answer in the DOM, for tests and for the preload script
 * in index.html (which sets the same attribute before first paint; this is the
 * only other writer).
 */
export function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset['theme'] = theme
}

// ── Buttons ──────────────────────────────────────────────────────────────────

export type ButtonVariant = 'primary' | 'ghost' | 'danger'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** The label. Prefer this over children so the busy state composes correctly. */
  text?: string
  variant?: ButtonVariant
  /** Shows a spinner and disables the control. */
  busy?: boolean
  children?: ReactNode
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
}

export function Button({ text, variant = 'ghost', busy = false, disabled, children, className, type, ...rest }: ButtonProps) {
  return (
    <button
      // Inside a form, a button with no type submits it. That default has
      // reloaded this app more than once.
      type={type ?? 'button'}
      className={[VARIANT_CLASS[variant], className].filter(Boolean).join(' ')}
      disabled={disabled === true || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy && <Spinner />}
      {text}
      {children}
    </button>
  )
}

/**
 * A destructive action, guarded.
 *
 * Every irreversible thing in this studio goes through here, because the ones
 * that did not were exactly the ones that shipped without a confirm: deleting a
 * state cascades through the graph and can leave a world unplayable, and
 * restoring a version overwrites everything authored since. `confirm` is
 * required — there is no way to construct this without saying what is at stake.
 */
export function DangerButton({ confirm, onClick, ...rest }: ButtonProps & { confirm: string }) {
  return (
    <Button
      {...rest}
      variant="danger"
      onClick={(e) => {
        if (window.confirm(confirm)) onClick?.(e)
      }}
    />
  )
}

// ── Structure ────────────────────────────────────────────────────────────────

export function Row({ children, wrap = false, className, style }: { children: ReactNode; wrap?: boolean; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={['row', className].filter(Boolean).join(' ')} style={wrap ? { flexWrap: 'wrap', ...style } : style}>
      {children}
    </div>
  )
}

export function Spacer() {
  return <span className="spacer" />
}

export function Pill({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="pill" title={title}>
      {children}
    </span>
  )
}

export function Muted({ children, size, className }: { children: ReactNode; size?: number; className?: string }) {
  return (
    <span className={['muted', className].filter(Boolean).join(' ')} style={size !== undefined ? { fontSize: size } : undefined}>
      {children}
    </span>
  )
}

export function Spinner() {
  return <span className="spin" />
}

/**
 * Wraps a control in a console-box treatment: four ASCII corner-bracket
 * accents around whatever is passed in. Decorative only — the corners are
 * `aria-hidden` spans, so the wrapped control (a TextArea, a preview image)
 * stays the one interactive/announced thing inside it.
 */
// ── Feedback ─────────────────────────────────────────────────────────────────

export type DiagKind = 'error' | 'warning' | 'info'

/**
 * A message about what just happened, or what is wrong.
 *
 * `role="status"` on non-errors and `role="alert"` on errors, so a screen reader
 * announces a failure rather than leaving it to be noticed visually.
 */
export function Diag({ kind, children }: { kind: DiagKind; children: ReactNode }) {
  return (
    <div className={`diag ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}

// ── Fields ───────────────────────────────────────────────────────────────────

/**
 * A labelled control. The label is bound to the control by id rather than by
 * wrapping, so the hint can sit outside the label without being read as part of
 * it.
 */
export function Field({ id, label, hint, children }: { id: string; label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint !== undefined && (
        <div id={`${id}-hint`} className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {hint}
        </div>
      )}
    </>
  )
}

export function TextInput({ id, ...rest }: InputHTMLAttributes<HTMLInputElement> & { id: string }) {
  return <input id={id} spellCheck={false} autoComplete="off" aria-describedby={`${id}-hint`} {...rest} />
}

/**
 * Forwards its ref, because a caller that must MEASURE the control cannot go
 * through this component otherwise — and the composer's auto-growing prompt is
 * exactly that: it reads scrollHeight to size itself. Without the ref the only
 * way to build it was a raw <textarea> in a domain view, which is the thing
 * this vocabulary exists to prevent, so the vocabulary grew instead.
 */
export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { id: string }>(
  function TextArea({ id, ...rest }, ref) {
    return <textarea ref={ref} id={id} aria-describedby={`${id}-hint`} {...rest} />
  },
)

export function Select({ id, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { id: string }) {
  return (
    <select id={id} aria-describedby={`${id}-hint`} {...rest}>
      {children}
    </select>
  )
}

/**
 * A labelled checkbox. The whole row is the hit target, and the value flows as
 * a boolean rather than an event — the caller states what it wants to know, not
 * how the DOM said it.
 */
export function Checkbox({ label, checked, onChange, disabled }: {
  label: ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

// ── Toast ────────────────────────────────────────────────────────────────────

/**
 * The one transient toast. Three views used to each hold their own copy of this
 * state machine, and two of them had already drifted apart on the dismiss
 * timing — the exact fate of any treatment that exists in more than one place.
 * The hook owns message/error/timer; the caller renders `toastEl` wherever its
 * layout wants the toast to sit.
 */
export function useToast(): { toast: (msg: string, err?: boolean) => void; toastEl: ReactNode } {
  const [state, setState] = useState<{ msg: string; err: boolean; n: number } | null>(null)
  useEffect(() => {
    if (!state) return
    const t = window.setTimeout(() => setState(null), 2600)
    return () => window.clearTimeout(t)
  }, [state])
  const toast = useCallback((msg: string, err = false) => setState({ msg, err, n: Date.now() }), [])
  const toastEl = state ? <div className={'toast' + (state.err ? ' err' : '')}>{state.msg}</div> : null
  return { toast, toastEl }
}
