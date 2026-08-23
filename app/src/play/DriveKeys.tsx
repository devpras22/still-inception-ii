/**
 * The controls, on screen, lit as you hold them.
 *
 * Rendering key HINTS is common; rendering which key is DOWN is the point
 * here. A player pressing a key and seeing nothing move has no way
 * to tell a dead control from a world that ignored them, and that ambiguity is
 * exactly what hid the layout bug: on AZERTY the W position emits "z", driving
 * was keyed on the character, and WASD did nothing at all. Lit caps would have
 * said so in one press.
 *
 * The caps are labelled from the browser's own layout map where it exists, so an
 * AZERTY board reads Z Q S D. Where it does not, the fallback engraving is
 * QWERTY — possibly the wrong letter, never the wrong POSITION, and the cap
 * still lights under whichever key was actually pressed.
 */
import { useEffect, useState } from 'react'
import { KEYCAP_ROWS, capFor, driveLabel } from './keys'

export function DriveKeys({ held, enabled }: { held: ReadonlySet<string>; enabled: boolean }) {
  const [layout, setLayout] = useState<ReadonlyMap<string, string> | undefined>(undefined)

  useEffect(() => {
    // Chromium-only, and asked for once. A board whose browser cannot answer
    // gets the fallback engraving rather than a missing HUD.
    // A GUARD, not a cast: `navigator.keyboard` is Chromium-only, so its
    // presence is a runtime question and `as Navigator & {...}` would be the
    // claim rather than the check.
    let alive = true
    const kb: unknown = 'keyboard' in navigator ? navigator.keyboard : undefined
    const getLayoutMap =
      kb !== null && typeof kb === 'object' && 'getLayoutMap' in kb
        ? (kb as { getLayoutMap: unknown }).getLayoutMap
        : undefined
    if (typeof getLayoutMap === 'function') {
      void Promise.resolve(getLayoutMap.call(kb))
        .then((m: unknown) => { if (alive && m instanceof Map) setLayout(m) })
        .catch(() => {})
    }
    return () => { alive = false }
  }, [])

  if (!enabled) return null
  const doing = driveLabel(held)

  return (
    <div className="drivekeys" aria-hidden="true" data-testid="drive-keys">
      {KEYCAP_ROWS.map((row, i) => (
        <div key={i} className="drivekeys-row">
          {row.map((code) => (
            <span
              key={code}
              className={'drivekeys-cap' + (held.has(code) ? ' on' : '') + (code === 'Space' || code.startsWith('Shift') ? ' wide' : '')}
            >
              {capFor(code, layout)}
            </span>
          ))}
        </div>
      ))}
      {/* What the world is being TOLD, not what was pressed. A key that lights
          while this stays empty is a control the transport refused. */}
      <div className="drivekeys-doing">{doing ?? ''}</div>
    </div>
  )
}
