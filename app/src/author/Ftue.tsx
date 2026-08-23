/**
 * The first time you open the editor.
 *
 * A short stepped tour, shown once, reopenable from a `?`. Its content is
 * written against this editor's actual surfaces. A tour that names a control
 * which is not on screen, or skips one that is (arrival evidence, set-pieces,
 * the doctrine's plain-English fixes), would be worse than no tour at all.
 *
 * A surface nobody can find is a surface nobody uses — the most repeated
 * finding from building this editor's mechanics. The tour is the fix for
 * that, applied to the whole editor at once.
 *
 * Every step below names something that is TRUE and reachable in this build,
 * and says plainly where a key is needed — a newcomer discovering that the
 * agent needs their own model AFTER being told to use it is the worst version
 * of this screen.
 */
import { useState } from 'react'
import { Button } from '../theme'

const SEEN_KEY = 'alakazam-studio:ftue:v1'

interface Step {
  glyph: string
  kicker: string
  title: string
  body: React.ReactNode
}

const STEPS: Step[] = [
  {
    glyph: '◈',
    kicker: 'what this is',
    title: 'A game here is a map',
    body: (
      <>
        Every world is a <strong>map of states</strong> joined by the choices a player makes. This editor is
        that map. The world model draws each state from the prose you write for it.
      </>
    ),
  },
  {
    glyph: '▢',
    kicker: 'the nodes',
    title: 'A node is a state',
    body: (
      <>
        A state is one scene: its <strong>base</strong> prompt, its camera and movement while the player stands
        still or walks, and what the player <strong>reads</strong> there. Click a node to edit all of it on the
        right. Drag one to move it — where you put it is remembered.
      </>
    ),
  },
  {
    glyph: '→',
    kicker: 'the arrows',
    title: 'Arrows are the choices',
    body: (
      <>
        Each arrow is an <strong>event</strong> — something the player can do. Click one to give it its own shot,
        a <strong>hotkey</strong>, an <strong>anchor</strong> (an object in the picture they can click), or{' '}
        <strong>arrival evidence</strong>: what the picture must actually show before the destination is allowed
        to land.
      </>
    ),
  },
  {
    glyph: '⚑',
    kicker: 'the rules',
    title: 'The doctrine watches as you type',
    body: (
      <>
        The panel at the bottom left flags what would break the world — a negation the model will render
        literally, a trigger with nothing to watch, a quest nothing can finish. Each one says what it means in
        plain words, and some offer a one-click fix.
      </>
    ),
  },
  {
    glyph: '✦',
    kicker: 'the agent',
    title: 'Ask for what you want',
    body: (
      <>
        The composer floating over the map writes the graph for you — states, events, endings. It runs on{' '}
        <strong>your own model</strong>, so it needs a key in Settings first; without one it says so rather than
        pretending.
      </>
    ),
  },
  {
    glyph: '▶',
    kicker: 'playing it',
    title: 'Play, and direct',
    body: (
      <>
        <strong>▶ Play</strong> opens the world on whichever backend you configured. Objects the vision model
        finds become <strong>chips</strong> you can click, and typing an action while you play hands it to the{' '}
        <strong>director</strong>, which authors it into the world and plays it.
      </>
    ),
  },
  {
    glyph: '⎇',
    kicker: 'safety',
    title: 'Nothing needs saving',
    body: (
      <>
        Every edit is written as you make it. <strong>Versions</strong> keeps snapshots you can go back to, and
        the destructive actions ask first. Reopen this tour any time from the <strong>?</strong> above.
      </>
    ),
  },
]

export function hasSeenFtue(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    // A browser that refuses storage gets the tour every time, which is a much
    // smaller problem than a crash on the first screen anyone sees.
    return false
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1')
  } catch {
    /* see above */
  }
}

export function Ftue({ onClose }: { onClose: () => void }) {
  const [i, setI] = useState(0)
  const step = STEPS[i]
  if (!step) return null

  function finish(): void {
    markSeen()
    onClose()
  }

  return (
    <div className="ftue-scrim" role="dialog" aria-modal="true" aria-label="Editor tour">
      <div className="ftue">
        <div className="ftue-glyph" aria-hidden="true">{step.glyph}</div>
        <div className="ftue-kicker">{step.kicker}</div>
        <h2 className="ftue-title">{step.title}</h2>
        <div className="ftue-body">{step.body}</div>

        <div className="ftue-dots" aria-hidden="true">
          {STEPS.map((s, n) => (
            <span key={s.title} className={n === i ? 'ftue-dot on' : 'ftue-dot'} />
          ))}
        </div>

        <div className="row" style={{ gap: 8, marginTop: 14 }}>
          {/* Skipping is as legitimate as finishing, and burying it would make
              the tour a toll rather than an offer. */}
          <Button variant="ghost" text="Skip the tour" onClick={finish} />
          <span className="spacer" />
          {i > 0 && <Button variant="ghost" text="Back" onClick={() => setI(i - 1)} />}
          {i < STEPS.length - 1 ? (
            <Button variant="primary" text={`Next · ${i + 1}/${STEPS.length}`} onClick={() => setI(i + 1)} />
          ) : (
            <Button variant="primary" text="Make something" onClick={finish} />
          )}
        </div>
      </div>
    </div>
  )
}
