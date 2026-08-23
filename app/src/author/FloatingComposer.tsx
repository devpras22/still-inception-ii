import { useEffect, useState } from 'react'
import { Button } from '../theme'
import { Composer } from './Composer'
import { PREMISE_POOL } from './useComposer'

/**
 * The studio home's collapsed pill — the floating-composer chrome: "+ Create
 * a new world" with a 🎲 dice that drops a random premise straight into the
 * expanded card. Floats above whatever section the author is on, so creating
 * is one click away from anywhere, not only from the Create page.
 *
 * Mounts the card rather than merely showing it, and unmounts it on collapse —
 * `Composer` owns all its state through `useComposer`, so this is how "close
 * without creating" hands back a clean composer next time, the same way
 * navigating away from the page variant would.
 */
export function FloatingComposer({
  onCreated,
  openOnMount = false,
}: {
  onCreated: (worldId: string) => void
  /** Open expanded — what `?section=create` means now that there is no create
   *  page: the surface is the same one, the URL just arrives with it open. */
  openOnMount?: boolean
}) {
  const [expanded, setExpanded] = useState(openOnMount)
  const [seedPremise, setSeedPremise] = useState<string | undefined>(undefined)

  const collapse = () => setExpanded(false)

  // Escape collapses the card — the same keyboard-dismiss every other
  // floating/overlaid surface in the studio honours.
  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') collapse()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  function expandBlank() {
    setSeedPremise(undefined)
    setExpanded(true)
  }

  function expandRandom() {
    const idx = Math.floor(Math.random() * PREMISE_POOL.length)
    setSeedPremise(PREMISE_POOL[idx] ?? PREMISE_POOL[0])
    setExpanded(true)
  }

  return (
    <>
      {/* Dimming and blurring the catalogue behind an open composer is not
          decoration: it is what makes the card the only live thing on the
          screen while you are deciding what to build. Clicking it collapses,
          the way clicking outside a dialog does. */}
      {expanded && (
        <div
          className="composer-scrim"
          onClick={collapse}
          role="presentation"
        />
      )}
      <div className="composer-root">
        {expanded ? (
          <Composer
            onCreated={(id) => { collapse(); onCreated(id) }}
            onDismiss={collapse}
            initialPremise={seedPremise}
          />
        ) : (
          <div className="composer-pill">
            {/* aria-label, not the visible text, is what the accessible-name
                algorithm reports. Two on-screen controls both named "Create"
                is exactly the ambiguity WCAG 2.5.3 warns about for anyone
                driving by name; this one describes what it opens. */}
            <Button variant="ghost" onClick={expandBlank} aria-label="Open the floating world composer" text="+ Create a new world" />
            <Button
              variant="ghost"
              className="composer-dice"
              onClick={expandRandom}
              aria-label="Fill a random premise"
              title="Fill a random premise"
              text="🎲"
            />
          </div>
        )}
      </div>
    </>
  )
}
