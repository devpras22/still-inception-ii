#!/usr/bin/env node
// A world model running on YOUR machine: node examples/world-mira.mjs
//
// MIRA Mini is a neural world model of car soccer that runs on Apple silicon or
// CUDA with no account and no cloud. `mira-mini play` starts its engine, and the
// engine speaks its own dialect — not the studio's. This file is the bridge, and
// it is the whole of what "point the studio at a local model" costs: the studio
// itself needs no new provider, because `websocket` already speaks everything in
// docs/WEBSOCKET_PROTOCOL.md.
//
//   pip install alakazam-mira-mini
//   mira-mini play                       # UI on :8770, ENGINE on :8771/ws
//   node examples/world-mira.mjs         # this bridge on ws://localhost:8765
//
// Then in the studio: Settings -> World model -> WebSocket endpoint ->
// ws://localhost:8765 -> Test connection -> Save -> play any world.
//
//   node examples/world-mira.mjs [port] [engineUrl]
//     port       default 8765; 0 asks the OS for a free one
//     engineUrl  default ws://127.0.0.1:8771/ws  (mira-mini play --port N -> N+1)
//
// WHAT YOU ARE RUNNING, AND WHAT IT IS LICENSED AS. This file is part of the
// studio and carries the studio's Apache-2.0 licence. It ships no model. The
// runtime is installed by you from PyPI, and the weights are downloaded by that
// runtime, from its own repository, under ITS OWN licence — MIRA Mini's weights
// are CC BY-NC-SA, which is NON-COMMERCIAL. Nothing here grants you any right
// over them; the runtime says so itself on every boot. Point this bridge at a
// different local engine and none of that applies.
//
// WHAT HAS AND HAS NOT BEEN RUN. The translation below is checked on every
// `npm run check`, by this repository's own conformance tool, against a double of
// the engine dialect (tests/fixtures/mira-engine-double.mjs, read off
// the engine's own server). It has never been handshaked with the real engine on the
// machine that wrote it, because that needs a 5 GB weight download. So the wire
// is verified and the MODEL is not: if the rules payload, the key mapping or the
// hold window turn out to be wrong against real weights, that is where to look,
// and a fix belongs here rather than in the studio.
//
// ZERO DEPENDENCIES, like examples/world-echo.mjs and for the same reason: an
// integrator should be able to copy one file and read it end to end. That costs
// a second copy of RFC 6455 framing, which is the price of the file being
// self-contained rather than the start of a library.

import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { connect } from 'node:net'

const PORT = Number(process.argv[2] ?? 8765)
const ENGINE = process.argv[3] ?? 'ws://127.0.0.1:8771/ws'
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/**
 * What the studio is told, and every word of it is checkable.
 *
 * `promptableEvents: false` is the load-bearing one. The engine has no prose
 * channel at all — its only input message is a set of held KEYS — so an authored
 * state or prompt beat can never reach the picture. Declaring it true would give
 * the user a world where every transition fires, the HUD keeps up, and the
 * picture ignores all of it: the exact failure docs/WEBSOCKET_PROTOCOL.md calls
 * its own worst. Declared false, the studio shows a standing warning instead.
 *
 * The rate in the note is MEASURED, not estimated: 11 fps of real world steps
 * and a 76 ms step for the 364M model at 2 diffusion steps, on a 2021 MacBook
 * Pro M1 Pro 16GB. A machine with a discrete GPU running the 1B is a different
 * number; the note is a starting expectation, not a promise.
 */
const CAPABILITIES = {
  type: 'capabilities',
  streaming: true,
  promptableEvents: false,
  heldCommands: true,
  persistentWorlds: false,
  note:
    'MIRA Mini, running locally through mira-mini play. It takes held controls only, so authored prompt and state beats cannot reach the picture. About 11 fps on an M1 Pro (364M, 2 diffusion steps). Weights are CC BY-NC-SA: non-commercial.',
}

/**
 * The session settings the engine expects, copied from the defaults its own
 * relay sends (`server/rocket_league/config.py`, DEFAULT_RULES) rather than
 * guessed. `seat_modes` puts the player in seat 0 and lets the model imagine the
 * other three cars, which is what a single local player wants.
 *
 * `n_diffusion_steps` is a request, not a decision: `mira-mini play` pins the
 * few-step distillates to 2 with a hard override the engine honours over
 * anything a session asks for.
 */
const RULES = {
  match_seconds: 300,
  n_diffusion_steps: 8,
  seat_modes: ['human', 'model', 'model', 'model'],
  room_name: '',
  action_cfg: 1.0,
  decoder: 'default',
}

/**
 * The studio's control tokens, mapped onto the engine's key vocabulary
 * (`["W","A","S","D","Q","E","Space","LShiftKey","LControlKey"]`).
 *
 * A token with no entry is DROPPED rather than approximated. There is no camera
 * pitch in a car, so `look_up` and `look_down` have nowhere to go, and inventing
 * a key for them would put the car into a manoeuvre the player never asked for.
 */
const KEYS = {
  Front: 'W',
  Back: 'S',
  Left: 'A',
  Right: 'D',
  look_left: 'Q',
  look_right: 'E',
  Up: 'Space',
  Down: 'LShiftKey',
}

/**
 * How long a control stays pressed with nothing more heard about it.
 *
 * The studio sends one `command` per KEYDOWN and never sends a keyup: a held key
 * arrives as the browser's auto-repeat stream, and its release is either the
 * `idle` token (which authored drives send, `src/play/drive.ts`) or silence.
 * Silence is the case that needs a number. Too short and the car stutters
 * between repeats — the repeat delay is an OS preference and can be half a
 * second — too long and it keeps driving after the player let go. 700 ms clears
 * the longest common repeat delay and is still under a second of drift.
 */
const HOLD_MS = 700

// ── RFC 6455, both halves ────────────────────────────────────────────────────

/** Server->client frames are never masked; client->server frames always are. */
function encode(opcode, payload, mask) {
  const body = mask ? Buffer.from(payload) : payload
  const key = mask ? randomBytes(4) : null
  if (key) for (let i = 0; i < body.length; i += 1) body[i] ^= key[i % 4]
  const len = body.length
  const flag = mask ? 0x80 : 0x00
  let head
  if (len < 126) head = Buffer.from([0x80 | opcode, flag | len])
  else if (len < 65536) {
    head = Buffer.alloc(4)
    head[0] = 0x80 | opcode
    head[1] = flag | 126
    head.writeUInt16BE(len, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x80 | opcode
    head[1] = flag | 127
    head.writeBigUInt64BE(BigInt(len), 2)
  }
  return key ? Buffer.concat([head, key, body]) : Buffer.concat([head, body])
}

/** TCP does not respect message boundaries, so a frame arrives in pieces. */
function decode(buffer) {
  const frames = []
  let offset = 0
  for (;;) {
    if (buffer.length - offset < 2) break
    const opcode = buffer[offset] & 0x0f
    const masked = (buffer[offset + 1] & 0x80) !== 0
    let length = buffer[offset + 1] & 0x7f
    let cursor = offset + 2
    if (length === 126) {
      if (buffer.length - cursor < 2) break
      length = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break
      length = Number(buffer.readBigUInt64BE(cursor))
      cursor += 8
    }
    let mask = null
    if (masked) {
      if (buffer.length - cursor < 4) break
      mask = buffer.subarray(cursor, cursor + 4)
      cursor += 4
    }
    if (buffer.length - cursor < length) break
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length))
    if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
    frames.push({ opcode, payload })
    offset = cursor + length
  }
  return { frames, rest: buffer.subarray(offset) }
}

// ── The engine side ──────────────────────────────────────────────────────────

/**
 * Dial the local engine and speak its dialect.
 *
 * Nothing here is optional politeness: the engine REFUSES a connection whose
 * first message is not `start` ("first message must be start"), answers `ready`
 * rather than `capabilities`, and sends every frame as a JSON header naming the
 * byte length of each seat's picture followed by ONE binary message holding all
 * of them concatenated. Seat 0 is the player, so the bridge hands the studio
 * `payload[0 .. views[0])` and drops the rest — a browser told to decode the
 * whole concatenation would paint the first picture and silently ignore three
 * more, which is a different bug wearing the same face.
 */
function dialEngine({ onFrame, onEnded, onError, onReady }) {
  const u = new URL(ENGINE)
  const sock = connect({ host: u.hostname, port: Number(u.port || 80) })
  const key = randomBytes(16).toString('base64')
  const want = createHash('sha1').update(key + GUID).digest('base64')
  let handshaken = false
  let buffer = Buffer.alloc(0)
  let views = null
  let dead = false

  const send = (obj) => {
    if (!dead && handshaken) sock.write(encode(0x1, Buffer.from(JSON.stringify(obj)), true))
  }
  const die = (why) => {
    if (dead) return
    dead = true
    sock.destroy()
    onEnded(why)
  }

  sock.on('connect', () => {
    sock.write(
      `GET ${u.pathname || '/'} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    )
  })
  sock.on('error', (e) =>
    die(
      `could not reach the MIRA engine at ${ENGINE} (${e.message}). Start it with \`mira-mini play\` — the engine listens one port above the UI.`,
    ),
  )
  sock.on('close', () => die('the MIRA engine closed the connection'))

  sock.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    if (!handshaken) {
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) return
      const head = buffer.subarray(0, end).toString()
      if (!head.includes('101') || !head.toLowerCase().includes(want.toLowerCase())) {
        return die(`the MIRA engine refused the upgrade: ${head.split('\r\n')[0]}`)
      }
      handshaken = true
      buffer = buffer.subarray(end + 4)
      // Expensive work starts HERE, not when the studio probed us.
      send({ type: 'start', rules: RULES })
    }
    const { frames, rest } = decode(buffer)
    buffer = rest
    for (const f of frames) {
      if (f.opcode === 0x8) return die('the MIRA engine ended the session')
      if (f.opcode === 0x9) {
        sock.write(encode(0xa, f.payload, true))
        continue
      }
      if (f.opcode === 0x2) {
        if (!views || views.length === 0) continue
        const seat0 = views[0]
        if (seat0 > 0 && f.payload.length >= seat0) onFrame(f.payload.subarray(0, seat0))
        views = null
        continue
      }
      if (f.opcode !== 0x1) continue
      let m
      try {
        m = JSON.parse(f.payload.toString('utf8'))
      } catch {
        continue
      }
      if (m.type === 'ready') onReady(m.meta ?? {})
      else if (m.type === 'frame') views = Array.isArray(m.views) ? m.views : null
      else if (m.type === 'ended') die(m.reason || 'the MIRA session ended')
      else if (m.type === 'error') onError(String(m.detail ?? 'the MIRA engine reported an error'))
    }
  })

  return {
    hold: (keys) => send({ type: 'actions', held: { 0: keys } }),
    stop: () => {
      send({ type: 'stop' })
      setTimeout(() => die('stopped'), 200)
    },
  }
}

// ── The studio side ──────────────────────────────────────────────────────────

const server = createServer((_req, res) => {
  res.writeHead(426, { 'Content-Type': 'text/plain' })
  res.end('This endpoint speaks WebSocket. Point the studio at it.\n')
})

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  if (!key) return socket.destroy()
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${createHash('sha1').update(key + GUID).digest('base64')}\r\n\r\n`,
  )

  let engine = null
  let pending = Buffer.alloc(0)
  const held = new Map() // engine key -> the timer that will release it

  const sendText = (v) => socket.write(encode(0x1, Buffer.from(JSON.stringify(v))))
  const sendBinary = (b) => socket.write(encode(0x2, b))

  const flush = () => engine?.hold([...held.keys()])
  const release = (k) => {
    const t = held.get(k)
    if (t) clearTimeout(t)
    held.delete(k)
    flush()
  }
  const press = (k) => {
    const t = held.get(k)
    if (t) clearTimeout(t)
    held.set(k, setTimeout(() => release(k), HOLD_MS))
    flush()
  }
  const releaseAll = () => {
    for (const t of held.values()) clearTimeout(t)
    held.clear()
    flush()
  }

  const close = () => {
    for (const t of held.values()) clearTimeout(t)
    held.clear()
    engine?.stop()
    engine = null
  }

  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk])
    const { frames, rest } = decode(pending)
    pending = rest
    for (const f of frames) {
      if (f.opcode === 0x8) return (close(), socket.end())
      if (f.opcode === 0x9) {
        socket.write(encode(0xa, f.payload))
        continue
      }
      if (f.opcode !== 0x1) continue
      let m
      try {
        m = JSON.parse(f.payload.toString('utf8'))
      } catch {
        continue
      }
      if (m.type === 'hello') {
        // The probe sends hello alone and hangs up, so the engine is NOT dialed
        // here: a capability check must not wake a model.
        sendText(CAPABILITIES)
      } else if (m.type === 'start' && !engine) {
        console.log(`start ${m.worldId ?? ''} -> dialing ${ENGINE}`)
        engine = dialEngine({
          onReady: (meta) => console.log('engine ready', JSON.stringify(meta).slice(0, 200)),
          onFrame: (jpeg) => sendBinary(jpeg),
          onError: (detail) => sendText({ type: 'error', message: detail }),
          onEnded: (reason) => {
            engine = null
            sendText({ type: 'ended', reason })
          },
        })
      } else if (m.type === 'event') {
        // `prompt` and `state` are unreachable by declaration, so they are
        // dropped rather than mistranslated into a keypress.
        if (m.kind !== 'command' || typeof m.value !== 'string') continue
        if (m.value === 'idle') releaseAll()
        else if (KEYS[m.value]) press(KEYS[m.value])
      } else if (m.type === 'bye') {
        close()
        socket.end()
      }
    }
  })

  socket.on('close', close)
  socket.on('error', close)
})

server.listen(PORT, () => {
  const bound = server.address()?.port ?? PORT
  console.log(`world model on ws://localhost:${bound}  (engine ${ENGINE})`)
})
