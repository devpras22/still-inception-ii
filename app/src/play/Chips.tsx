import { useEffect, useRef, useState } from 'react'
import { DEFAULT_PROXIMITY } from '../world'
import type { SMEventAnchor } from '../world'
import { Button } from '../theme'
import { ANCHOR, boxToPercent, chipLabel, chipMode, chipRefusal, isActionable } from './anchors'
import type { AnchorTrack } from './anchors'

/** Only what a chip needs off a beat — structural, so this never imports the
 *  player that renders it. */
export interface ChipBeat {
  name: string
  label: string
  anchor?: SMEventAnchor | undefined
}

interface ChipsProps {
  beats: ChipBeat[]
  tracks: Record<string, AnchorTrack>
  /** The provider-owned mount, read for the picture's real dimensions. */
  mount: HTMLElement | null
  sending: string | null
  disabled: boolean
  onFire: (beat: ChipBeat) => void
}

/**
 * Interactions pinned to the objects they happen AT — the door, the statue,
 * the arch — instead of a rail of buttons under the picture.
 *
 * The studio used to draw a green rectangle around every detection with the
 * beat's name in the corner. That is a debug overlay: it says "the detector
 * found this", not "you can do this here". A CHIP at the object's centre
 * whose look tells you what to do about it, gated on the rules in
 * `anchors.ts` — proximity, aim, and a grace window — says the second thing
 * instead.
 *
 * The chip never greys out. An object you cannot act on yet is an objective
 * marker: cyan ◆ when it is ahead but too far, an orange arrow when it is off
 * to one side. Tapping either explains itself instead of doing nothing.
 */
export function Chips({ beats, tracks, mount, sending, disabled, onFire }: ChipsProps) {
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)
  useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current) }, [])
  function say(msg: string) {
    setToast(msg)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2200)
  }

  // Re-measure on resize: the mapping below reads the mount's live box, so a
  // window change silently strands every chip off its object without this.
  const [, bump] = useState(0)
  useEffect(() => {
    const onResize = () => bump((n) => n + 1)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const video = mount?.querySelector('video')
  const canvas = mount?.querySelector('canvas')
  const painted: { w: number; h: number; el: HTMLVideoElement | HTMLCanvasElement } | null =
    video instanceof HTMLVideoElement && video.videoWidth > 0
      ? { w: video.videoWidth, h: video.videoHeight, el: video }
      : canvas instanceof HTMLCanvasElement && canvas.width > 0
        ? { w: canvas.width, h: canvas.height, el: canvas }
        : null
  const rect = mount?.getBoundingClientRect()
  const view = { w: rect?.width ?? 0, h: rect?.height ?? 0 }
  // Whatever the provider actually chose. A chip positioned for `contain` over
  // a `cover` picture sits off its object by the crop, which reads as the
  // detector being wrong.
  const fit: 'cover' | 'contain' =
    painted && typeof getComputedStyle === 'function' && getComputedStyle(painted.el).objectFit === 'cover'
      ? 'cover'
      : 'contain'

  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const live = beats.filter((b) => b.anchor && tracks[b.name]?.hit)
  if (live.length === 0 && !toast) return null

  return (
    <div className="chip-layer">
      {live.map((beat) => {
        const track = tracks[beat.name]
        const hit = track?.hit
        if (!track || !hit) return null
        // NOT `?? 0`, which is what this was and which switched the aim gate OFF
        // for exactly the worlds most likely to need it. An anchor carries a
        // measured `minProximity` only when a first frame was painted and probed
        // — and the studio's own quick start is "no account, no key", so a new
        // author with no image provider generates a world whose every anchor has
        // none. At 0 the chip is actionable the moment the detector returns ANY
        // box: the doctrine's `sliver-evidence` defect — a sliver at the frame
        // edge counts, so the chip arms from across the room. Seen the other
        // way round on camera — a PROBED world (minProximity 0.135) held its
        // three chips in "turn to face" while the objects were off centre,
        // which is the behaviour an unprobed world was never getting.
        // The fallback is this studio's own DEFAULT_PROXIMITY, the same number
        // the mission compiler already uses for the same "get close" idea.
        const minProximity = beat.anchor?.minProximity ?? DEFAULT_PROXIMITY
        const mode = chipMode(track, now, minProximity, sending === beat.name)
        const { leftPct, topPct } = boxToPercent(hit.box, painted ?? { w: 0, h: 0 }, view, fit)
        const turn = track.turn?.dir ?? (hit.liveCx < 0.5 ? '◀' : '▶')
        return (
          <Button
            key={beat.name}
            variant="ghost"
            className={`chip chip-${mode}`}
            style={{ left: `${leftPct}%`, top: `${topPct}%` }}
            disabled={disabled}
            title={
              mode === 'beacon'
                ? `${beat.label} — head here, then it is interactable`
                : mode === 'turn'
                  ? `${beat.label} — turn to face it (it must be in front to interact)`
                  : beat.label
            }
            // POINTERDOWN, not click — and it is load-bearing. A `click` fires
            // on the common ancestor of the press and the release, and a chip
            // pinned to a live detection MOVES between the two: measured, the
            // press landed on the button and the click landed on
            // `div.play-picture`, so the handler never ran and a visibly armed
            // chip did nothing. Pressing is the whole interaction.
            onPointerDown={(e) => {
              e.preventDefault()
              // Read the gate at PRESS time, not at render time: the grace
              // window is a clock, and the render that drew this chip may be
              // two seconds old.
              if (!isActionable(track, performance.now(), minProximity)) {
                say(chipRefusal(track, beat.label))
                return
              }
              onFire(beat)
            }}
          >
            {chipLabel(mode, beat.label, turn)}
          </Button>
        )
      })}
      {toast && <div className="chip-toast" role="status">{toast}</div>}
    </div>
  )
}

/** Re-exported so a caller can pace its probe loop off the same numbers the
 *  chips are gated on, rather than a second copy of them. */
export { ANCHOR }
