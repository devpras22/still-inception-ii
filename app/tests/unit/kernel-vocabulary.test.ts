/**
 * The kernel's prompt must NAME every capability a generated world should carry.
 *
 * Found twice by measurement and now executable. The editor agent could not
 * reach eight ops that existed, were validated and had passing tests, purely
 * because its prompt never named them: 10/10 on listed ops, 0/8 on unlisted.
 * Then the same thing, one level up — a five-premise live sweep of the KERNEL
 * found seventeen capabilities that never appeared in ANY generated world, and
 * the six worth having were absent for exactly the same reason. `grants`,
 * `lockedHint`, `set_story`, `set_subject`, `narration` and `logline` had ZERO
 * mentions in the file. Naming them took locks from 0/5 to 7/10 and the subject
 * lock from 0/5 to 9/10.
 *
 * A capability the kernel never produces is invisible to every new author, and
 * the only place that fact shows up is a live sweep nobody runs on a schedule.
 * So it is a test: add a field to the world that a generated world ought to
 * have, and this fails until the prompt teaches the kernel to write it.
 *
 * It deliberately checks the PROMPT and not a generated world — asserting on a
 * model's output would be a flaky test of somebody else's weights. What this
 * owns is the half we control.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const KERNEL = readFileSync(new URL('../../src/author/agent/generate.ts', import.meta.url), 'utf8')

/** Everything a generated world should be able to carry, and the token that
 *  proves the prompt teaches it. */
const MUST_NAME: [string, string][] = [
  ['layered prose', 'ambient'],
  ['a camera register', 'camera'],
  ['endings', 'ending'],
  ['clickable anchors', 'anchor'],
  ['the flag that opens a lock', 'grants'],
  ['the flag a lock demands', 'requires'],
  ['what a locked event tells the player', 'lockedHint'],
  ['the world logline', 'set_story'],
  ['the subject lock', 'set_subject'],
  ['per-state narration', 'narration'],
  ['choreographed transitions', 'phases'],
  ['arrival evidence', 'landWhen'],
  ['a mission', 'add_mission'],
]

/**
 * Capabilities a generated world should NOT carry, with the reason. Listed so
 * the absence is a decision on the record rather than an oversight — the live
 * sweep reports these as "never produced" every time it runs.
 */
const DELIBERATELY_ABSENT: Record<string, string> = {
  introVideo: 'needs a video clip the kernel cannot make',
  outro: 'needs a video clip the kernel cannot make',
  add_cutscene: 'needs a video clip the kernel cannot make',
  add_variant: 'an A/B experiment is an authorial act, not a default',
  add_sequence: 'set-piece pacing is an authorial act',
  waypoint: 'needs distances in metres the kernel has no way to judge',
  terminal: 'a character who talks is a big authorial choice, not a default',
}

test('the kernel prompt names every capability a generated world should carry', () => {
  const missing = MUST_NAME.filter(([, token]) => !KERNEL.includes(token)).map(([what, token]) => `${what} (${token})`)
  assert.deepEqual(
    missing,
    [],
    'the kernel cannot write what its prompt never mentions — a live sweep is the only other way to find this',
  )
})

test('the capabilities the kernel deliberately skips are on the record', () => {
  // Not a behavioural check: it pins the LIST, so removing a reason is a
  // deliberate edit rather than a quiet one.
  assert.equal(Object.keys(DELIBERATELY_ABSENT).length, 7)
  for (const [field, reason] of Object.entries(DELIBERATELY_ABSENT)) {
    assert.ok(reason.length > 20, `${field} needs a real reason, not a shrug`)
  }
})

/**
 * The critique round must not ask for the world to be re-emitted.
 *
 * By the time `verifyWorld` scores a world, its ops have ALREADY been applied —
 * that is the only way there is a world to score. The critique used to close
 * with "Emit the WHOLE world again as one ops array", so the model dutifully
 * re-sent `add_state` for states that now existed, the store refused the batch
 * ("a state called X already exists"), and the round was spent on a collision
 * the instruction had asked for. Measured in a 20-generation sweep: one of the
 * two hard failures ran exactly that way — negation errors, then a 97/100
 * verdict, then a collision, then out of rounds and nothing written.
 */
test('the critique asks for ops against the world as it stands, not a rewrite', async () => {
  const { critique } = await import('../../src/world')
  const text = critique({
    pass: false,
    score: 97,
    issues: ['only one branch'],
    stats: { states: 6, events: 7, branchPoints: 1, winStates: 1, loseStates: 1 },
  } as never)

  assert.match(text, /ALREADY WRITTEN/, 'it says the world exists')
  assert.match(text, /Do not re-add/, 'and that re-adding is the trap')
  assert.doesNotMatch(
    text,
    /WHOLE world again/,
    'asking for a full re-emit collides with every state the previous round created',
  )
})
