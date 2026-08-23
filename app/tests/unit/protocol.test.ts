/**
 * The wire, checked by the thing that checks other people's wires.
 *
 * `docs/WEBSOCKET_PROTOCOL.md` names its own worst failure — "a server that
 * claims promptableEvents: true and then ignores event messages" — and says
 * plainly that the studio cannot detect it: it "takes your reply literally and
 * has no way to check it". So `scripts/protocol-check.mjs` is the only thing
 * standing between an integrator and a world where every beat fires and the
 * picture never moves, and these tests are the only thing standing behind it.
 *
 * Two subjects live here because they are one concept: what goes on the wire.
 * The reference server proves the checker is honest; the MIRA bridge proves a
 * real local runtime can be reached without the studio growing a provider.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// fileURLToPath, NOT `.pathname`. On Windows a file URL's pathname is
// `/C:/Users/...` — with a leading slash — so `join()` produces a path that does
// not exist and `spawn` fails. That is "a gate that has only ever run on one OS
// has an untested half", written after the convention checker had this exact
// bug, and then reintroduced here in the test that verifies other people's
// servers.
const root = fileURLToPath(new URL('../../', import.meta.url))

/** Start a node server on a port the OS chooses and resolve once it says which.
 *
 *  Servers here used to sit on fixed ports until a stray process was found on
 *  one a since-deleted test had used the day before, which would have made this
 *  fail for nobody's reason. A fixture that ANNOUNCES its port removes both the
 *  collision and the guessing: the wait is for a fact, not for a hopeful 1200ms. */
function serve(file: string, args: string[] = []): Promise<{ port: number; log: string[]; kill: () => void }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [file, ...args], { stdio: ['ignore', 'pipe', 'ignore'] })
    const log: string[] = []
    const give = setTimeout(() => {
      proc.kill()
      reject(new Error(`${file} never announced a port`))
    }, 10_000)
    let settled = false
    proc.stdout.on('data', (b: Buffer) => {
      const text = String(b)
      log.push(...text.split('\n').filter(Boolean))
      if (settled) return
      const m = /ws:\/\/localhost:(\d+)/.exec(log.join('\n'))
      if (!m?.[1]) return
      settled = true
      clearTimeout(give)
      resolve({ port: Number(m[1]), log, kill: () => proc.kill() })
    })
  })
}

/** Run the checker the way an integrator would, and hand back its verdict and
 *  its report — the report is where the byte counts live. */
function check(port: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const proc = spawn('node', [join(root, 'scripts/protocol-check.mjs'), `ws://localhost:${port}`], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    proc.stdout.on('data', (b: Buffer) => { out += String(b) })
    proc.on('exit', (code) => resolve({ code: code ?? -1, out }))
  })
}

test('protocol-check passes an honest server and fails one that ignores events', async () => {
  const echo = readFileSync(join(root, 'examples/world-echo.mjs'), 'utf8')
  const REACTS = "      else if (message.type === 'event' && message.value) colour = colour.map((c) => (c * 7 + 90) % 256)"
  assert.ok(echo.includes(REACTS), 'the echo server still has one line that reacts to an event')

  const dir = mkdtempSync(join(tmpdir(), 'studio-proto-'))
  const run = async (file: string, mode?: string): Promise<number> => {
    const server = await serve(file, mode ? ['0', mode] : ['0'])
    try {
      return (await check(server.port)).code
    } finally {
      server.kill()
    }
  }

  try {
    // This also pins the WIRE SHAPE the checker sends. The reference server moves
    // its picture only when an event carries `value`, which is the field the
    // protocol defines and the only one the studio ever fills in — so a checker
    // that invents `prompt`/`command` fields instead cannot pass this line. It
    // could not, for as long as both were wrong together.
    assert.equal(await run(join(root, 'examples/world-echo.mjs')), 0, 'the shipped echo server honours what it declares, and the checker sends events under `value`')

    const liar = join(dir, 'liar.mjs')
    writeFileSync(liar, echo.replace(REACTS, "      else if (message.type === 'event') { /* ignores it */ }"))
    assert.equal(await run(liar), 1, 'a server that declares promptableEvents and ignores events must FAIL')

    // A PICTURE IS NOT ALWAYS BINARY. The checker shipped counting binary
    // payloads only, so it failed a CONFORMING server that sent
    // {"type":"frame","url":…} — one of the four documented ways to send a
    // picture. It told an integrator their frames never arrived while the
    // browser would have painted them. This is the mode that caught it.
    assert.equal(await run(join(root, 'examples/world-echo.mjs'), 'url'), 0, 'a server that sends pictures by URL must PASS')

    // ONE CONNECTION, EVER. The studio retries an abnormal close five times and
    // re-sends hello then start on each attempt, so a server that serves a single
    // socket looks perfect until the first hiccup and then the session is over for
    // good — a failure that arrives long after the integration "worked". This one
    // also DECLARES persistentWorlds, so both checks must fire.
    const once = join(dir, 'once.mjs')
    writeFileSync(once, echo
      .replace("server.on('upgrade', (req, socket) => {", "let served = 0\nserver.on('upgrade', (req, socket) => {\n  if (served++ > 0) { socket.destroy(); return }")
      .replace('  persistentWorlds: false,', '  persistentWorlds: true,'))
    assert.equal(await run(once), 1, 'a server that accepts one connection and claims persistentWorlds must FAIL')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * THE LOCAL RUNTIME, reached without a new provider.
 *
 * `examples/world-mira.mjs` bridges the studio's dialect to the one
 * `mira-mini play` starts, and the two share the word `frame` and nothing else:
 * the engine refuses any first message that is not `start`, answers `ready`
 * rather than `capabilities`, sends four seats' JPEGs concatenated behind one
 * header, and takes a set of held KEYS where the studio sends control tokens.
 *
 * WHAT THIS PROVES: the translation, in both directions, checked by the repo's
 * own conformance tool against a double of the engine dialect read from
 * the engine's own server. WHAT IT CANNOT PROVE, and what nothing here should be read
 * as claiming: that MIRA Mini itself runs, at what rate, or that the keys it is
 * handed steer a car anywhere sensible. Those need the weights, and the weights
 * are a 5 GB download under a non-commercial licence that this repository will
 * never ship.
 */
test('the MIRA bridge speaks both dialects, and the engine hears the right keys', async () => {
  const engine = await serve(join(root, 'tests/fixtures/mira-engine-double.mjs'), ['0'])
  const bridge = await serve(join(root, 'examples/world-mira.mjs'), ['0', `ws://127.0.0.1:${engine.port}/ws`])
  try {
    // A PROBE MUST NOT WAKE THE MODEL. The studio checks capabilities by sending
    // `hello` alone and hanging up — that is why hello and start are separate
    // messages at all — so a bridge that dials on hello spins a laptop's GPU up
    // every time somebody opens Settings. This is the probe, verbatim.
    const probe = new WebSocket(`ws://localhost:${bridge.port}`)
    const declared = await new Promise<string>((resolve, reject) => {
      const give = setTimeout(() => reject(new Error('the bridge never answered hello')), 5000)
      probe.onopen = () => probe.send(JSON.stringify({ type: 'hello', studio: 'test', protocol: 1 }))
      probe.onmessage = (e) => {
        clearTimeout(give)
        resolve(String(e.data))
      }
    })
    probe.close()
    assert.match(declared, /"type":"capabilities"/, 'the bridge answers hello without help from the engine')
    assert.match(declared, /"promptableEvents":false/, 'the engine has no prose channel, and the bridge must say so')
    await new Promise((r) => setTimeout(r, 500))
    assert.equal(engine.log.filter((l) => l.startsWith('start ')).length, 0, `a capability probe started an engine session: ${engine.log.join(' | ')}`)

    const report = await check(bridge.port)
    assert.equal(report.code, 0, `every capability the bridge declares, it honours:\n${report.out}`)

    // ONE SEAT, NOT FOUR. The engine sends every seat's picture concatenated
    // behind one header, and a browser handed the whole run paints the first and
    // ignores the rest — so forwarding all of it looks identical on screen and
    // is only visible as weight on the wire. The double makes the other three
    // seats six times the size of seat 0 for exactly this line: sliced is about
    // 11KB across the run, unsliced is about twenty times that.
    const kb = Number(/(\d+)KB/.exec(report.out)?.[1] ?? -1)
    assert.ok(kb > 0 && kb < 60, `the bridge forwarded more than seat 0's picture (${kb}KB):\n${report.out}`)

    // READ IT OFF THE ENGINE. A bridge that swallowed the control token and
    // still let the picture change would pass the checker; the engine's own log
    // is the vantage that cannot miss what it was actually told.
    const held = engine.log.filter((l) => l.startsWith('held '))
    assert.ok(held.some((l) => l.includes('"W"')), `the studio's \`Front\` never reached the engine as W: ${held.join(' | ')}`)
    assert.ok(
      engine.log.some((l) => l.startsWith('start ') && l.includes('"seat_modes"')),
      `the session never started with the engine's own rules: ${engine.log.join(' | ')}`,
    )
  } finally {
    bridge.kill()
    engine.kill()
  }
})
