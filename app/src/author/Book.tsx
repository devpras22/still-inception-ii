/**
 * Book → Game. The door to the book path.
 *
 * `runBookToCampaign` has been able to read a book into a spine, author every
 * act through the kernel, join them into a campaign and lint the result — and
 * until now its only call site in the entire repository was a tool leaf. It
 * worked from the CLI and from an agent, and a person sitting in the studio
 * could not start it. Only an audit of which capabilities have a way IN could
 * surface that: 298 unit tests and 65 end-to-end tests all pass over a path
 * with no entry point. Tests check that a thing works, never that anyone can
 * reach it.
 *
 * The panel is deliberately thin: it owns the text, the progress lines and the
 * result. Everything else — segmentation, the spine, per-act authoring, the
 * lints — belongs to the tool, so the CLI and this screen cannot drift.
 */
import { useState } from 'react'
import { useClient } from '../studio'
import { Button, Field, TextArea } from '../theme'
import { BOOK_MIN_CHARS } from './agent/book'

interface ActRow {
  actId: string
  title: string
  worldId: string
  states: number
  canonical: boolean
}

export function Book({ onPlay }: { onPlay?: ((worldId: string) => void) | undefined }) {
  const { tools } = useClient()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  /** The kernel's own notes, act by act — forwarded so a four-minute run is
   *  not a blank screen with a spinner on it. */
  const [notes, setNotes] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [acts, setActs] = useState<ActRow[] | null>(null)
  const [diagnostics, setDiagnostics] = useState<string[]>([])
  const [title, setTitle] = useState('')

  const trimmed = text.trim()
  const short = trimmed.length < BOOK_MIN_CHARS

  async function layItOut(): Promise<void> {
    setBusy(true)
    setError(null)
    setActs(null)
    setNotes([])
    setDiagnostics([])
    // Only the last note per act is worth keeping on screen: the kernel emits a
    // line per correction round, and a scrolling wall of them hides the act
    // names, which are the thing a reader is actually waiting for.
    const res = await tools.run(
      'author.book',
      { text: trimmed },
      { onProgress: (note: string) => setNotes((prev) => [...prev.slice(-11), note]) },
    )
    setBusy(false)
    if (!res.ok) {
      setError(res.error.message || 'the book could not be laid out')
      return
    }
    const value = res.value as {
      campaign?: { title?: string; graph?: { acts?: { actId: string; title?: string; worldId: string; canonical?: boolean }[] } }
      worlds?: { actId: string; states: number }[]
      diagnostics?: { message: string; severity?: string }[]
    }
    const states = new Map((value.worlds ?? []).map((w) => [w.actId, w.states]))
    setTitle(value.campaign?.title ?? '')
    setActs(
      (value.campaign?.graph?.acts ?? []).map((a) => ({
        actId: a.actId,
        title: a.title ?? a.actId,
        worldId: a.worldId,
        states: states.get(a.actId) ?? 0,
        canonical: a.canonical !== false,
      })),
    )
    setDiagnostics((value.diagnostics ?? []).filter((d) => d.severity !== 'warning').map((d) => d.message))
  }

  return (
    <section className="panel">
      <h2>Book → Game</h2>
      <p className="muted">
        Paste a book, or a long extract. It is read into beats and a world bible, laid out as a
        spine of acts, and every act is authored into its own world by the same kernel a single
        premise uses — then joined into one story and linted before it can be played.
      </p>

      <Field id="book-text" label="The book">
        <TextArea
          id="book-text"
          rows={12}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
          placeholder="Paste the text here. A chapter makes one world; a book makes several, joined."
        />
      </Field>

      <div className="row" style={{ alignItems: 'center', gap: 10 }}>
        {/* Ghost until it is actually available. `button:disabled` dims to 45%,
            which on a black background still leaves a saturated green reading as
            clickable — the control announced itself as the next thing to do
            while refusing to do it. The primary weight arrives with the ability. */}
        <Button
          variant={short || busy ? 'ghost' : 'primary'}
          disabled={busy || short}
          onClick={() => void layItOut()}
          text={busy ? 'Laying out the acts…' : 'Lay out the book'}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          {short
            ? `${trimmed.length} of ${BOOK_MIN_CHARS} characters — a shorter text is a chapter, or a premise.`
            : `${trimmed.length} characters. This takes a few minutes: every act is authored in full.`}
        </span>
      </div>

      {notes.length > 0 && (
        <div className="notes" style={{ marginTop: 12 }}>
          {notes.map((n, i) => (
            <div key={`${i}-${n}`} className="muted" style={{ fontSize: 12 }}>{n}</div>
          ))}
        </div>
      )}

      {error && <div className="warn" style={{ marginTop: 12 }} data-testid="book-error">{error}</div>}

      {acts && (
        <div style={{ marginTop: 16 }} data-testid="book-result">
          <h3>{title || 'The campaign'}</h3>
          {/* Diagnostics FIRST. A campaign with an error will refuse to open, so
              burying that under a list of acts would send someone to press Play
              on a story the doctrine has already declined. */}
          {diagnostics.length > 0 && (
            <div className="warn" style={{ marginBottom: 10 }}>
              {diagnostics.map((d) => <div key={d}>{d}</div>)}
            </div>
          )}
          {diagnostics.length === 0 && (
            <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
              The story passes its own lints — it can be played end to end.
            </div>
          )}
          {acts.map((a) => (
            <div key={a.actId} className="row" style={{ alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <span style={{ minWidth: 210 }}>
                {a.title}{' '}
                <span className="muted" style={{ fontSize: 11 }}>
                  {a.canonical ? 'on the spine' : 'off the spine'} · {a.states} states
                </span>
              </span>
              {onPlay && <Button variant="ghost" onClick={() => onPlay(a.worldId)} text="Play" />}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
