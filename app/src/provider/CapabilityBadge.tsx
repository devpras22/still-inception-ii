import type { CSSProperties } from 'react'
// Namespace import: the registry exports free functions, and this keeps the call
// sites reading as registry.capabilityWarning() without coupling to a wrapper object.
import * as registry from './registry'
import type { WorldCapabilities } from './types'
import { Spinner } from '../theme'

/**
 * The probe result, made impossible to miss.
 *
 * The dangerous failure here is silent, not loud: a backend that streams frames
 * but ignores authored world events looks completely healthy. Frames arrive, the
 * HUD updates, transitions fire in the studio — and the picture never changes.
 * People lose an hour to that before suspecting the backend. So the warning is
 * rendered as a standing block with role="alert", and there is deliberately no
 * dismiss control: the condition is still true tomorrow, and a banner you can
 * close is a banner nobody reads twice.
 *
 * Every chip carries a glyph AND a word AND a colour, so the row still reads on
 * a monochrome display or to someone who cannot separate green from grey.
 */

/** The boolean half of WorldCapabilities — `note` is prose, not a capability. */
type CapKey = Exclude<keyof WorldCapabilities, 'note'>

const CAPS: { key: CapKey; label: string; why: string }[] = [
  { key: 'streaming', label: 'Frames', why: 'Produces video frames at all. Off means the provider is inert.' },
  { key: 'promptableEvents', label: 'World events', why: 'Takes authored beats mid-session — the thing that makes a state machine visible.' },
  { key: 'heldCommands', label: 'Held input', why: 'Takes held movement/look input (WASD-style driving).' },
  { key: 'persistentWorlds', label: 'Persistent worlds', why: 'Can create a world that later sessions re-enter by id.' },
]

/**
 * Kept here rather than in the registry so that a provider which returns no
 * message still cannot suppress the warning. The flag is what triggers it; the
 * registry only gets to phrase it.
 */
const FALLBACK_WARNING =
  'This backend will not accept the events your world sends it. States change and transitions fire exactly as authored — the picture is simply not listening, so none of it reaches the screen.'

/** Visually hidden but still announced — the chips must not signal by colour alone. */
const SR_ONLY: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
}

export function CapabilityBadge({
  capabilities,
  probing = false,
  compact = false,
}: {
  capabilities: WorldCapabilities
  /** A probe is in flight: show that, not the previous result, which may be stale. */
  probing?: boolean
  /** Tighter type/padding for headers and toolbars. Never hides the warning. */
  compact?: boolean
}) {
  if (probing) {
    return (
      <div className="row muted" style={{ fontSize: compact ? 11 : 12 }} role="status" aria-live="polite">
        <Spinner /> asking the backend what it can do…
      </div>
    )
  }

  const warning = registry.capabilityWarning(capabilities)
  const text = warning ?? (capabilities.promptableEvents ? null : FALLBACK_WARNING)
  const heading = capabilities.promptableEvents
    ? 'Check this backend before you build on it'
    : capabilities.streaming
      ? 'Authored world events will not reach this backend'
      : 'This backend is neither drawing nor listening'

  // `note` usually says why a probe failed, and the warning often already says
  // it. Printing the same sentence twice reads like a stutter, so show it once.
  const showNote = !!capabilities.note && !(text && text.includes(capabilities.note))

  return (
    <div>
      <ul
        aria-label="Backend capabilities"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 6, listStyle: 'none', margin: 0, padding: 0 }}
      >
        {CAPS.map((c) => {
          const on = capabilities[c.key]
          // Only promptableEvents earns the warning colour when it is off. The
          // others being off is a limitation; this one is the trap.
          const tone = on
            ? { color: 'var(--acc)', borderColor: 'var(--ok-line)' }
            : c.key === 'promptableEvents'
              ? { color: 'var(--warn)', borderColor: 'var(--warn-line)' }
              : { color: 'var(--dim)', borderColor: 'var(--line)' }
          return (
            <li
              key={c.key}
              className="badge"
              title={c.why}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: compact ? '2px 7px' : '3px 9px',
                fontSize: compact ? 10 : 11,
                position: 'relative',
                ...tone,
              }}
            >
              <span aria-hidden="true" style={{ fontWeight: 700 }}>{on ? '✓' : '✕'}</span>
              {c.label}
              <span style={SR_ONLY}>: {on ? 'supported' : 'not supported'}. {c.why}</span>
            </li>
          )
        })}
      </ul>

      {showNote && (
        <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>{capabilities.note}</p>
      )}

      {text && (
        <div
          role="alert"
          className="diag warning"
          style={{
            marginTop: 10,
            padding: compact ? '7px 10px' : '10px 12px',
            borderLeftWidth: 4,
            background: 'var(--warn-bg)',
            color: 'var(--ink)',
            fontSize: compact ? 12 : 13,
            borderRadius: '0 6px 6px 0',
          }}
        >
          <strong style={{ color: 'var(--warn)' }}>
            <span aria-hidden="true">⚠ </span>{heading}
          </strong>
          <div style={{ marginTop: 4 }}>{text}</div>
        </div>
      )}
    </div>
  )
}
