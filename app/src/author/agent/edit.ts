/**
 * Natural-language world editing, run against YOUR language model.
 *
 * This exists because the studio shipped a whole LLM provider layer — Cerebras,
 * Groq, OpenAI, OpenRouter, Ollama, LM Studio, custom endpoints, presets, key
 * storage, a connection test — and the only thing that ever called it was the
 * "Test connection" button in Settings. The agent bar, the one feature that is
 * actually AI authoring, posted to the hosted `/v1/worlds/:id/edit` endpoint
 * regardless. So "bring your own LLM" was true of the settings screen and false
 * of the product: your key proved it worked and then went unused.
 *
 * The hosted endpoint does prompt engineering, applies ops and validates
 * server-side. Locally we do the same three steps in the open: describe the
 * graph, ask for ops, apply them through the `author.ops` tool — the same
 * validated path the CLI's `author ops` takes. The op vocabulary comes from
 * the world domain's own narrower (`PUBLIC_OPS` / `toPublicOps`), so nothing
 * here can express an edit the store would not accept.
 *
 * FAIL-CLOSED. A reply we cannot parse into valid ops changes nothing and is
 * shown to the user as-is. A half-applied graph is worse than a refused edit.
 */
import type { LLMProvider } from '../../provider'
import type { ToolOutcome } from '../../tool'
import type { WorldStore } from '../../world'
import type { Diagnostic, PublicOp, SMEvent, SMState } from '../../world'
import { extractJson, ReplyParseError } from './reply'
import { toPublicOps } from '../../world'

export interface LocalEditResult {
  reply: string
  diagnostics: Diagnostic[]
  /** How many ops were applied. 0 means nothing changed. */
  applied: number
  /** Directives the model itself asked for — its goto-chain, kept because the
   *  pacing of a move is a creative call the graph cannot infer. Checked
   *  against the graph downstream by `safeDirectives`, never trusted here. */
  asked?: { goto?: string; fire?: string; afterMs?: number }[] | undefined
}

export class LocalEditError extends Error {
  constructor(message: string, readonly raw?: string) {
    super(message)
    this.name = 'LocalEditError'
  }
}

/** Tries before the edit is reported as failed. Same budget as the director's,
 *  for the same reason: one correction fixes almost everything a model gets
 *  wrong, and a third try has never been observed to rescue what a second
 *  could not. */
const MAX_ROUNDS = 3

const SYSTEM = `You edit small state machines that describe interactive worlds.

A world is states and events. A state has an id and a "base" prompt: prose describing
what the camera sees while the world is in that state. An event moves between states
("transition", with from/to) or modifies the current one ("override", from only).
A state may carry an "ending" ({kind:"win"|"lose", title, subtitle}).

You reply with STRICT JSON and nothing else:
{"reply": "<one or two sentences for the author>", "ops": [ ... ]}

Each op is one of:
{"op":"add_state","id":"<snake_case>","base":"<prose>"}
{"op":"update_state","id":"<existing>","patch":{"base":"<prose>"}}
{"op":"delete_state","id":"<existing>"}
{"op":"add_event","name":"<snake_case>","kind":"transition","from":["<state>"],"to":"<state>","base":"<optional prose>"}
{"op":"add_event","name":"<snake_case>","kind":"override","from":["<state>"],"detail":"<prose>"}
{"op":"update_event","name":"<existing>","patch":{...}}
{"op":"delete_event","name":"<existing>"}
{"op":"set_entrance","state":"<existing>"}

For a change to ONE thing, prefer the op named after that thing — it is smaller,
it cannot disturb a neighbouring field, and it says what you did:
{"op":"set_field","state":"<existing>","field":"base|camera.static|camera.dynamic|movement.static|movement.dynamic","value":"<prose>"}
{"op":"set_event_field","event":"<existing>","field":"base|detail","value":"<prose>"}
{"op":"rename_state","from":"<existing>","to":"<snake_case>"}
{"op":"set_state_ending","state":"<existing>","kind":"win|lose","title":"<title>","subtitle":"<optional>"}
{"op":"set_event_anchor","event":"<existing>","label":"<object visible in the frame>"}
{"op":"set_event_hotkey","event":"<existing>","hotkey":"<single key>"}
{"op":"set_event_grants","event":"<existing>","grants":["<flag>"]}
{"op":"set_event_requires","event":"<existing>","requires":["<flag>"]}
{"op":"set_event_locked_hint","event":"<existing>","hint":"<what the player is missing>"}
{"op":"set_subject","subject":"<the one creature or vehicle this world follows>"}
{"op":"add_transition","from":"<state>","to":"<state>","name":"<snake_case>","base":"<optional prose>"}
{"op":"add_override","from":"<state>","name":"<snake_case>","detail":"<prose>"}
{"op":"remove_state","id":"<existing>"}
{"op":"remove_event","name":"<existing>"}
{"op":"set_event_kind","event":"<existing>","kind":"transition|override|terminal","to":"<state, transitions only>"}
{"op":"set_event_drive","event":"<existing>","movement":"forward|back|strafe_left|strafe_right","lookHorizontal":"left|right","lookVertical":"up|down"}
{"op":"set_event_phases","event":"<existing>","phases":[{"base":"<prose>","camera":"<optional>","minMs":<optional number>}, ...]}
{"op":"set_variant_field","state":"<existing>","label":"<variant label>","field":"base|camera.static|camera.dynamic|movement.static|movement.dynamic","value":"<prose>"}

Rules:
- Only reference state and event ids that exist, or that you create in an earlier op.
- Renaming a state is \`rename_state\`, never delete-then-add: deleting a state
  also deletes every event left with no source, and re-adding does not bring
  them back.
- Prose is what a camera sees. Concrete and visual. No instructions to the player,
  no second person, no naming the mechanics.
- Make the smallest change that satisfies the instruction. Do not restructure.
- If the instruction cannot be done with these ops, return an empty ops array and
  say why in reply.`

/** Compact view of the graph — enough to edit against, small enough to be cheap. */
function describe(states: Record<string, SMState>, events: SMEvent[]): string {
  const s = Object.entries(states).map(([id, st]) => ({
    id,
    base: st.base,
    ...(st.ending ? { ending: st.ending } : {}),
  }))
  const e = events.map((ev) => ({
    name: ev.name, kind: ev.kind, from: ev.from, ...(ev.to ? { to: ev.to } : {}),
    ...(ev.base ? { base: ev.base } : {}), ...(ev.detail ? { detail: ev.detail } : {}),
  }))
  return JSON.stringify({ states: s, events: e }, null, 1)
}


/**
 * Validate op shape before anything is written. A non-array reply means "no ops
 * proposed" (empty, not an error). An array reaches `toPublicOps`, the store's
 * own narrower, for membership and shape — so this can never drift from what
 * `author.ops` actually accepts; its thrown Error becomes a LocalEditError.
 */
function toOps(raw: unknown): PublicOp[] {
  if (!Array.isArray(raw)) return []
  try {
    return toPublicOps(raw)
  } catch (e) {
    throw new LocalEditError(e instanceof Error ? e.message : String(e))
  }
}

/**
 * Enough for one edit — this path rewrites a field or adds a state, and the
 * whole-graph budget lives in `generate.ts` (16000).
 *
 * The number is not the interesting part; the fact that it is a PARAMETER is.
 * Measured live on a real Cerebras session: the director sends a much longer
 * brief and asks for a state plus three events of full-density prose, GLM spent
 * the entire 4096 on reasoning tokens — which draw from the same budget — and
 * returned `finish_reason: length` with an empty message THREE times in a row.
 * The fix for the same failure raises the ceiling to 16384 — the old 2048 had
 * been truncating extensive edits.
 * A budget sized for the caller you had is a budget that breaks on the next one.
 */
export const EDIT_MAX_TOKENS = 4096

export async function runLocalEdit(opts: {
  llm: LLMProvider
  store: WorldStore
  tools: { run(path: string, input: Record<string, unknown>, opts?: { origin?: 'app' | 'agent' }): Promise<ToolOutcome> }
  worldId: string
  rev?: string
  instruction: string
  signal?: AbortSignal | undefined
  /** Room for the answer. See `EDIT_MAX_TOKENS`. */
  maxTokens?: number | undefined
}): Promise<LocalEditResult> {
  const { llm, store, tools, worldId, instruction, signal } = opts

  const scene = await store.getScene(worldId)
  const ask = async (correction: string): Promise<string> =>
    llm.complete({
      json: true,
      signal,
      temperature: 0.2,
      // Room for a reasoning pass AND the ops JSON. Reasoning models bill their
      // thinking against the same budget, so a tight limit truncates the answer
      // into unparseable JSON rather than failing loudly.
      maxTokens: opts.maxTokens ?? EDIT_MAX_TOKENS,
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content:
            `Current world:\n${describe(scene.states, scene.events)}\n\nInstruction: ${instruction}` +
            correction,
        },
      ],
    })

  let lastError = ''
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const text = await ask(
      round === 1
        ? ''
        : `\n\nYour previous answer was REFUSED and nothing was written:\n${lastError}\n` +
          `Send the whole edit again, corrected. If a flag has to be required, some event must grant it first.`,
    )

    // The shared reader speaks in its own voice; this agent's callers catch
    // LocalEditError, so the failure is translated rather than leaked.
    let raw: unknown
    try {
      raw = extractJson(text)
    } catch (e) {
      if (e instanceof ReplyParseError) {
        // A truncated or chatty answer is worth ONE more ask for the same
        // reason a refused write is: the model can usually do it again.
        lastError = e.message
        if (round < MAX_ROUNDS) continue
        throw new LocalEditError(`${e.message}.`, text)
      }
      throw e
    }
    const parsed: { reply?: unknown; ops?: unknown; directives?: unknown } =
      raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    const reply = typeof parsed.reply === 'string' && parsed.reply.trim()
      ? parsed.reply.trim()
      : 'The model returned no explanation.'
    const ops = toOps(parsed.ops)
    if (ops.length === 0) return { reply, diagnostics: [], applied: 0 }

    // Use the rev we just read, not the caller's: the read above is the freshest
    // view, and applying against a staler rev would 409 for no reason.
    const res = await tools.run('author.ops', { world: worldId, ops, rev: scene.rev }, { origin: 'agent' })
    // WHAT THE MODEL ASKED FOR, carried through. The agent's own goto-chain is
    // kept when nothing fresh is playable, since the pacing of a move is a
    // creative call the graph can't infer, and dropping it meant the director
    // could only ever play a single inferred beat. Narrowed here rather than
    // trusted: a directive is two optional strings, and the graph checks them
    // later.
    const asked = Array.isArray(parsed.directives)
      ? parsed.directives.flatMap((d) => {
          // A guard, not a cast: this is a language model's JSON, the least
          // trustworthy input in the codebase, and `as Record` would be the
          // claim rather than the check.
          if (d === null || typeof d !== 'object' || Array.isArray(d)) return []
          const rec: Record<string, unknown> = { ...d }
          const goto = typeof rec['goto'] === 'string' ? rec['goto'] : undefined
          const fire = typeof rec['fire'] === 'string' ? rec['fire'] : undefined
          const afterMs = typeof rec['afterMs'] === 'number' ? rec['afterMs'] : undefined
          return goto || fire ? [{ ...(goto ? { goto } : {}), ...(fire ? { fire } : {}), ...(afterMs ? { afterMs } : {}) }] : []
        })
      : []
    if (res.ok) return { reply, diagnostics: res.diagnostics, applied: ops.length, asked }

    // THE CORRECTION ROUND, which the director already had and this agent did
    // not. An agent-origin batch is refused whole if it would
    // introduce a doctrine error, so a model that helpfully adds
    // `requires: ['has_light']` beside the hint it was asked for loses the hint
    // as well — the author sees nothing happen and is told nothing. Measured:
    // that exact self-inflicted `unreachable-require` was 2 of the 3 failures
    // in the whole 54-trial vocabulary sweep. Handing the refusal back is
    // strictly better than naming the rule in the prompt, because it covers
    // every doctrine rule rather than the one that happened to bite.
    lastError = res.error.message
    if (round === MAX_ROUNDS) throw new LocalEditError(lastError)
  }
  throw new LocalEditError(lastError || 'the model could not produce a valid edit.')
}
