/**
 * Reading a language model's reply.
 *
 * Both agents in this corner — the kernel that authors a world and the editor
 * that changes one — ask for STRICT JSON and get back whatever the model felt
 * like sending: fenced in ```json, wrapped in an apology, prefixed with "Sure!".
 * Each had grown its own extractor, and the two had already drifted apart (one
 * tried a bare parse first, the other went straight for the braces), which is
 * how the same input starts producing two different answers depending on which
 * agent received it.
 *
 * One reader, then. It is deliberately TOLERANT of packaging and completely
 * INTOLERANT of content: it will dig an object out of a fence or a paragraph,
 * and it will refuse anything that is not one, because the caller's next move
 * is to apply ops to somebody's world.
 */

/** Thrown when a reply carries no usable JSON object. Callers wrap it in their
 *  own error type so the failure still reads in that agent's own voice. */
export class ReplyParseError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message)
    this.name = 'ReplyParseError'
  }
}

/**
 * Pull the one JSON object out of a model reply.
 *
 * Order matters: a bare parse first, so a well-behaved model's exact bytes are
 * used as sent, and only then the brace-scan salvage for the models that talk
 * around their answer.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = (fenced ? fenced[1] : trimmed) ?? trimmed
  try {
    return JSON.parse(body)
  } catch {
    const candidates = balancedObjects(body)
    if (candidates.length === 0) throw new ReplyParseError('the model did not return JSON', text)
    // The ANSWER, not the first thing that looked like one. A reasoning model
    // thinks out loud before it answers and its thinking is full of braces —
    // `I should use {"op":"add_state"} here` — so prefer a candidate carrying
    // the reply's own keys, and among those the LAST, because the thinking
    // comes first and the answer comes last.
    const answers = candidates.filter((v) => isRecord(v) && ('ops' in v || 'reply' in v || 'question' in v))
    const chosen = answers.length > 0 ? answers[answers.length - 1] : candidates[candidates.length - 1]
    if (chosen === undefined) throw new ReplyParseError('the model returned JSON that does not parse', text)
    return chosen
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Every complete `{...}` in the text, parsed.
 *
 * The salvage this replaced took the FIRST `{` to the LAST `}` and parsed the
 * span between them, which is correct only when the model says nothing else.
 * One brace anywhere in a reasoning preamble, or one stray `}` in a trailing
 * remark, and that span is malformed prose — the kernel then spends all four
 * correction rounds being told "that was not valid JSON" about an answer that
 * was complete and well-formed. Measured as the last remaining kernel failure
 * (1 generation in 20; both captured raws ended in a clean `}`), and reproduced
 * from three realistic reasoning-model shapes.
 *
 * Depth counting respects string literals, or a brace inside authored prose
 * ("the door is shut {like this}") would end the object early.
 */
function balancedObjects(body: string): unknown[] {
  const out: unknown[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; continue }
    if (c === '{') {
      if (depth === 0) start = i
      depth += 1
      continue
    }
    if (c === '}') {
      if (depth === 0) continue
      depth -= 1
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(body.slice(start, i + 1)))
        } catch {
          /* an unparseable span is not a candidate; keep scanning */
        }
        start = -1
      }
    }
  }
  return out
}
