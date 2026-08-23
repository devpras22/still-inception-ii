import { useCallback, useEffect, useRef, useState } from 'react'
import { useClient } from '../studio'
import type { EditorPanelProps } from './types'
import type { Hotspot } from '../world'
import { toApiFailure } from '../world'
import { Button, Field, Pill, Select, Spinner, TextArea } from '../theme'

/**
 * VisionPanel — the interactive-objects differentiator.
 *
 * A frame in, clickable objects out:
 *  1. Pick a frame — defaults to the world's cover (fetched → base64), or upload one.
 *  2. Perceive (`/v1/perceive`) → a room summary + visible objects / affordances / exits.
 *  3. Detect (`/v1/ground/objects`) → bounding boxes for a set of labels (typed, or the
 *     visible list from perceive). Boxes are 0–1000 normalized (origin top-left).
 *  4. Pin a detected object to one of the world's events (`updateEvent` with an
 *     `anchor: { label }`). That makes the event's choice a clickable object in the player.
 *
 * Writes thread `rev` as If-Match; a 409 means someone edited first → reload + retry.
 * Vision endpoints can 402 (plan limit), 413 (frame too big), 503 (temporarily down).
 */

type Perception = { summary: string; visible: string[]; affordances: string[]; exits: string[] }

/** Read a Blob (uploaded file or fetched cover) into a raw base64 (no data: prefix) + a dataURL for preview. */
function blobToB64(blob: Blob): Promise<{ b64: string; dataUrl: string }> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => {
      const dataUrl = String(fr.result)
      const comma = dataUrl.indexOf(',')
      resolve({ b64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl, dataUrl })
    }
    fr.onerror = () => reject(new Error('Could not read image data.'))
    fr.readAsDataURL(blob)
  })
}

/** Friendly, status-specific copy for the vision endpoints' known failures. */
function visionErrorMessage(e: unknown, fallback: string): string {
  const f = toApiFailure(e)
  switch (f.status) {
    case 402:
      return `Blocked by your plan limit (402). ${f.detail || 'Check today’s usage in Account, then retry.'}`
    case 413:
      return `Frame too large (413). ${f.detail || 'Use a smaller image — downscale it before uploading.'}`
    case 503:
      return `Vision service temporarily unavailable (503). ${f.detail || 'Please try again in a moment.'}`
    default:
      return f.detail || fallback
  }
}

/** Turn a 0–1000 normalized [x0,y0,x1,y1] bbox into an overlay box style (percent of the frame). */
function bboxStyle(bbox: number[]): React.CSSProperties | null {
  if (!Array.isArray(bbox) || bbox.length < 4) return null
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = bbox
  return {
    left: `${Math.min(x0, x1) / 10}%`,
    top: `${Math.min(y0, y1) / 10}%`,
    width: `${Math.abs(x1 - x0) / 10}%`,
    height: `${Math.abs(y1 - y0) / 10}%`,
  }
}

function fmtConfidence(c: number): string {
  if (!Number.isFinite(c)) return ''
  return c <= 1 ? `${Math.round(c * 100)}%` : String(Math.round(c))
}

export function VisionPanel(props: EditorPanelProps) {
  const { worldId, world, rev, reload, toast } = props
  const { client, tools, providers } = useClient()
  // Vision is a HOSTED call. Without a configured key it must not fire at all:
  // both endpoints POST the user's frame to api.alakazam.gg, and on a keyless
  // offline clone that meant the picture left the machine — to a vendor host
  // the user never configured — before they got a 401 back. CreatePanel already
  // gates its hosted calls this way; this panel did not.
  const visionAvailable = !!providers.world.alakazam.apiKey

  // ── Frame source ──────────────────────────────────────────────────────────
  const [frameB64, setFrameB64] = useState<string | null>(null)
  const [framePreview, setFramePreview] = useState<string | null>(null)
  const [frameLoading, setFrameLoading] = useState(false)
  const [frameNote, setFrameNote] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const didAutoLoad = useRef(false)

  // ── Analysis results ────────────────────────────────────────────────────
  const [perception, setPerception] = useState<Perception | null>(null)
  const [perceiving, setPerceiving] = useState(false)
  const [labelsInput, setLabelsInput] = useState('')
  const [hotspots, setHotspots] = useState<Hotspot[]>([])
  const [detecting, setDetecting] = useState(false)
  const [pinningIdx, setPinningIdx] = useState<number | null>(null)
  const [pinned, setPinned] = useState<Record<number, string>>({})
  const [error, setError] = useState<string | null>(null)

  const events = world.scene?.events ?? []

  const resetAnalysis = useCallback(() => {
    setPerception(null)
    setHotspots([])
    setPinned({})
    setError(null)
  }, [])

  // Load the world's cover as the default frame (fetch → base64). Cross-origin
  // covers can't be read for analysis; we still show them and prompt an upload.
  const loadCover = useCallback(async () => {
    const cover = world.cover
    if (!cover) return
    setFrameLoading(true)
    setFrameNote(null)
    setError(null)
    resetAnalysis()
    try {
      const res = await fetch(cover)
      if (!res.ok) throw new Error(`fetch cover failed (${res.status})`)
      const { b64, dataUrl } = await blobToB64(await res.blob())
      setFrameB64(b64)
      setFramePreview(dataUrl)
    } catch {
      setFrameB64(null)
      setFramePreview(cover)
      setFrameNote("Couldn't read the cover for analysis (cross-origin). Upload a frame instead.")
    } finally {
      setFrameLoading(false)
    }
  }, [world.cover, resetAnalysis])

  // Auto-load the cover once on mount so there's a frame ready to analyze.
  useEffect(() => {
    if (didAutoLoad.current) return
    if (world.cover) {
      didAutoLoad.current = true
      void loadCover()
    }
  }, [loadCover, world.cover])

  const onFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = '' // allow re-selecting the same file later
      if (!file) return
      setFrameLoading(true)
      setFrameNote(null)
      resetAnalysis()
      try {
        const { b64, dataUrl } = await blobToB64(file)
        setFrameB64(b64)
        setFramePreview(dataUrl)
      } catch (err) {
        setError(toApiFailure(err).detail || 'Could not read that image.')
      } finally {
        setFrameLoading(false)
      }
    },
    [resetAnalysis],
  )

  // ── Perceive ──────────────────────────────────────────────────────────────
  const doPerceive = useCallback(async () => {
    if (!frameB64 || perceiving || !visionAvailable) return
    setPerceiving(true)
    setError(null)
    try {
      const res = await client.perceive({ frame_b64: frameB64, room_name: world.name })
      setPerception(res)
      // Seed the detect labels with what we just saw (only if the box is empty).
      setLabelsInput((cur) => (cur.trim() ? cur : res.visible.join(', ')))
      toast(`Perceived ${res.visible.length} object${res.visible.length === 1 ? '' : 's'}`)
    } catch (e) {
      const msg = visionErrorMessage(e, 'Perceive failed.')
      setError(msg)
      toast(msg, true)
    } finally {
      setPerceiving(false)
    }
  }, [client, frameB64, perceiving, world.name, toast, visionAvailable])

  // ── Detect (ground objects) ────────────────────────────────────────────────
  const doDetect = useCallback(async () => {
    if (!frameB64 || detecting || !visionAvailable) return
    const labels = labelsInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (labels.length === 0) {
      toast('Add at least one label to detect.', true)
      return
    }
    setDetecting(true)
    setError(null)
    setPinned({})
    try {
      const res = await client.groundObjects({ frame_b64: frameB64, labels })
      setHotspots(res.hotspots)
      toast(`Detected ${res.hotspots.length} hotspot${res.hotspots.length === 1 ? '' : 's'}`)
    } catch (e) {
      const msg = visionErrorMessage(e, 'Detect failed.')
      setError(msg)
      toast(msg, true)
    } finally {
      setDetecting(false)
    }
  }, [client, frameB64, detecting, labelsInput, toast, visionAvailable])

  // ── Pin a detected object to an event's anchor ─────────────────────────────
  const pinToEvent = useCallback(
    async (idx: number, label: string, eventName: string) => {
      if (!eventName || pinningIdx !== null) return
      setPinningIdx(idx)
      try {
        const outcome = await tools.run('author.ops', {
          world: worldId,
          ops: [{ op: 'update_event', name: eventName, patch: { anchor: { label } } }],
          rev,
        })
        if (outcome.ok) {
          await reload()
          setPinned((prev) => ({ ...prev, [idx]: eventName }))
          toast(`Pinned “${label}” → ${eventName}`)
        } else if (outcome.error.conflict) {
          await reload()
          toast('reload & retry', true)
        } else {
          const msg = outcome.error.message || 'Pin failed.'
          setError(msg)
          toast(msg, true)
        }
      } finally {
        setPinningIdx(null)
      }
    },
    [tools, worldId, rev, reload, toast, pinningIdx],
  )

  const hasFrame = !!frameB64

  return (
    <div>
      <h3>Vision</h3>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        Turn a frame into clickable objects: <strong>Perceive</strong> to see what's in the room,{' '}
        <strong>Detect</strong> to box specific labels, then pin a box to an event so that choice
        becomes a clickable object in the player.
      </p>

      {/* Frame source + preview */}
      <label>Frame</label>
      <div
        style={{
          position: 'relative',
          borderRadius: 8,
          overflow: 'hidden',
          border: '1px solid var(--line)',
          background: 'var(--media-bg)',
          aspectRatio: '16 / 9',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {framePreview ? (
          <img
            src={framePreview}
            alt="frame"
            style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
          />
        ) : (
          <span className="muted" style={{ fontSize: 12 }}>
            {frameLoading ? (
              <>
                <Spinner /> loading frame…
              </>
            ) : (
              'no frame — use the cover or upload one'
            )}
          </span>
        )}
        {/* Detected boxes overlaid on the frame (0–1000 normalized → %). */}
        {framePreview &&
          hotspots.map((h, i) => {
            const st = bboxStyle(h.bbox)
            if (!st) return null
            return (
              <div
                key={`box-${i}`}
                style={{
                  position: 'absolute',
                  ...st,
                  border: '1.5px solid var(--acc)',
                  borderRadius: 3,
                  boxShadow: '0 0 0 1px rgba(0,0,0,.5)',
                  pointerEvents: 'none',
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    top: -16,
                    left: -1,
                    fontSize: 10,
                    background: 'var(--acc)',
                    color: 'var(--acc-ink)',
                    padding: '0 4px',
                    borderRadius: 3,
                    whiteSpace: 'nowrap',
                    fontWeight: 600,
                  }}
                >
                  {h.label}
                </span>
              </div>
            )
          })}
      </div>

      <div className="row" style={{ marginTop: 8, gap: 8 }}>
        <Button
          variant="ghost"
          onClick={() => void loadCover()}
          disabled={!world.cover || frameLoading}
          title={world.cover ? 'Use this world’s cover as the frame' : 'This world has no cover'}
        >
          {frameLoading ? <Spinner /> : 'Use cover'}
        </Button>
        <Button variant="ghost" onClick={() => fileRef.current?.click()} disabled={frameLoading} text="Upload frame" />
        {/* Programmatically triggered via fileRef — TextInput is a plain
            function component (no forwardRef), so it cannot carry the ref this
            click() depends on. Stays a raw, visually hidden input. */}
        <input ref={fileRef} type="file" accept="image/*" onChange={(e) => void onFile(e)} style={{ display: 'none' }} />
      </div>
      {frameNote && (
        <div className="diag warning" style={{ marginTop: 8 }}>
          {frameNote}
        </div>
      )}

      {/* Perceive */}
      <div className="row" style={{ marginTop: 14, gap: 8 }}>
        <Button
          variant="primary"
          onClick={() => void doPerceive()}
          disabled={!hasFrame || perceiving || !visionAvailable}
          title={visionAvailable ? undefined : 'Vision runs on the hosted API — add a key in Settings. It is not available offline.'}
        >
          {perceiving ? (
            <>
              <Spinner /> Perceiving…
            </>
          ) : (
            'Perceive'
          )}
        </Button>
        <span className="muted" style={{ fontSize: 11 }}>
          what's in this room?
        </span>
      </div>

      {perception && (
        <div className="card" style={{ marginTop: 12, background: 'var(--bg)' }}>
          {perception.summary && (
            <div style={{ marginBottom: perception.visible.length ? 10 : 0 }}>{perception.summary}</div>
          )}
          {perception.visible.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                visible
              </div>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {perception.visible.map((v) => (
                  <span key={`vis-${v}`} className="pill">
                    {v}
                  </span>
                ))}
              </div>
            </div>
          )}
          {perception.affordances.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                affordances
              </div>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {perception.affordances.map((a) => (
                  <span key={`aff-${a}`} className="pill">
                    {a}
                  </span>
                ))}
              </div>
            </div>
          )}
          {perception.exits.length > 0 && (
            <div>
              <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                exits
              </div>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {perception.exits.map((x) => (
                  <span key={`exit-${x}`} className="pill">
                    {x}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Detect */}
      <Field id="vis-labels" label="Labels to detect (comma-separated)">
        <TextArea
          id="vis-labels"
          value={labelsInput}
          onChange={(e) => setLabelsInput(e.target.value)}
          placeholder="e.g. red door, lantern, chest, guard"
          rows={2}
          spellCheck={false}
        />
      </Field>
      <div className="row" style={{ marginTop: 8, gap: 8 }}>
        <Button
          variant="primary"
          onClick={() => void doDetect()}
          disabled={!hasFrame || detecting || !labelsInput.trim() || !visionAvailable}
          title={visionAvailable ? undefined : 'Vision runs on the hosted API — add a key in Settings. It is not available offline.'}
        >
          {detecting ? (
            <>
              <Spinner /> Detecting…
            </>
          ) : (
            'Detect'
          )}
        </Button>
        {perception && perception.visible.length > 0 && (
          <Button variant="ghost" onClick={() => setLabelsInput(perception.visible.join(', '))} disabled={detecting} text="Use visible list" />
        )}
        <span className="muted" style={{ fontSize: 11 }}>
          bbox is 0–1000 normalized (top-left origin)
        </span>
      </div>

      {/* Hotspots */}
      {hotspots.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
            hotspots <Pill>{hotspots.length}</Pill>
          </div>
          {hotspots.map((h, i) => {
            const pinnedTo = pinned[i]
            return (
              <div key={`hs-${i}`} className="card" style={{ background: 'var(--bg)', padding: 10, marginBottom: 8 }}>
                <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                  <strong>{h.label}</strong>
                  {Number.isFinite(h.confidence) && <span className="muted" style={{ fontSize: 11 }}>{fmtConfidence(h.confidence)}</span>}
                </div>
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                  bbox <code>[{Array.isArray(h.bbox) ? h.bbox.join(', ') : '—'}]</code>
                </div>

                {events.length === 0 ? (
                  <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                    No events yet — add one in the Inspector to pin this object.
                  </div>
                ) : (
                  <div className="row" style={{ marginTop: 8, gap: 8 }}>
                    <Select
                      id={`vis-hotspot-pin-${i}`}
                      aria-label={`Pin ${h.label} to an event`}
                      defaultValue=""
                      disabled={pinningIdx !== null}
                      onChange={(e) => {
                        const name = e.target.value
                        if (name) void pinToEvent(i, h.label, name)
                        e.target.value = ''
                      }}
                      style={{ flex: 1 }}
                    >
                      <option value="" disabled>
                        Pin to event…
                      </option>
                      {events.map((ev) => (
                        <option key={ev.name} value={ev.name}>
                          {ev.name}
                        </option>
                      ))}
                    </Select>
                    {pinningIdx === i && <Spinner />}
                  </div>
                )}
                {pinnedTo && (
                  <div className="muted" style={{ fontSize: 11, marginTop: 6, color: 'var(--acc)' }}>
                    pinned → <code>{pinnedTo}</code>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {error && (
        <div className="diag error" style={{ marginTop: 14 }}>
          {error}
        </div>
      )}
    </div>
  )
}
