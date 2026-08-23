#!/usr/bin/env node
/**
 * protocol-check — point it at your world model and find out what you got wrong.
 *
 *   node scripts/protocol-check.mjs ws://localhost:8765
 *
 * `docs/WEBSOCKET_PROTOCOL.md` is 427 lines of contract and, until now, the only
 * way to know whether your server honoured it was to wire it into the studio and
 * squint at a black rectangle. This plays the studio's side of the conversation
 * and reports, claim by claim, what your server actually did.
 *
 * THE CHECK THAT MATTERS is the one the protocol doc names as its own worst
 * failure: "A server that claims `promptableEvents: true` and then ignores event
 * messages." The studio cannot catch that — it "takes your reply literally and
 * has no way to check it", so the symptom is a world where every authored beat
 * fires, the HUD updates, and the picture never changes. This does catch it: it
 * sends a prompt and watches whether your pixels move. Same for `heldCommands`.
 *
 * A declaration you do not honour is worse than a capability you do not have,
 * because the second is handled and the first is a bug in someone else's world.
 *
 * Zero dependencies, like the echo server it was written against: the WebSocket
 * client is ~70 lines of `node:net` and `node:crypto`, and asking an integrator
 * to `npm i` before they can test their own server is the thing this repository
 * keeps refusing to do.
 */
import { connect } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const url = process.argv[2] ?? 'ws://localhost:8765'
const QUIET_MS = Number(process.env.QUIET_MS ?? 4000)

if (process.argv.includes('--help')) {
  console.log(`
protocol-check — verify a world model against docs/WEBSOCKET_PROTOCOL.md

  node scripts/protocol-check.mjs [ws://host:port]

It connects as the studio does, then checks:

  handshake      you answer 'hello' with a 'capabilities' message
  shape          every declared field has the type the protocol says
  frames         a picture actually arrives after 'start' (when streaming)
  promptable     if you declare promptableEvents, a 'prompt' CHANGES the picture
  held input     if you declare heldCommands, a 'command' CHANGES the picture

The last two are the point. The studio cannot verify a declaration — it believes
you — so a server that claims a capability and ignores it produces a world where
every beat fires and nothing ever moves. Exit code is non-zero if any claim you
made is not honoured.
`)
  process.exit(0)
}

// ── A WebSocket client, small enough to read ────────────────────────────────
const u = new URL(url)
const sock = connect({ host: u.hostname, port: Number(u.port || 80) })
const key = randomBytes(16).toString('base64')
const expect = createHash('sha1').update(key + GUID).digest('base64')

const frames = { count: 0, bytes: 0, lastPayload: null, digests: [] }
const messages = []
let handshaken = false
let buffer = Buffer.alloc(0)

const send = (obj) => sock.write(encode(0x1, Buffer.from(JSON.stringify(obj))))

/** Client frames MUST be masked (RFC 6455) — servers close the socket if not. */
function encode(opcode, payload) {
  const mask = randomBytes(4)
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4]
  const len = masked.length
  const head = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len])
    : len < 65536 ? Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 126]), be16(len)])
      : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), be64(len)])
  return Buffer.concat([head, mask, masked])
}
const be16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b }
const be64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b }

function decode(buf) {
  const out = []
  let i = 0
  while (i + 2 <= buf.length) {
    const opcode = buf[i] & 0x0f
    let len = buf[i + 1] & 0x7f
    let off = i + 2
    if (len === 126) { if (off + 2 > buf.length) break; len = buf.readUInt16BE(off); off += 2 }
    else if (len === 127) { if (off + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(off)); off += 8 }
    if (off + len > buf.length) break
    out.push({ opcode, payload: buf.subarray(off, off + len) })
    i = off + len
  }
  return { out, rest: buf.subarray(i) }
}

sock.on('connect', () => {
  sock.write(
    `GET ${u.pathname || '/'} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\n` +
    `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  )
})

sock.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  if (!handshaken) {
    const end = buffer.indexOf('\r\n\r\n')
    if (end === -1) return
    const head = buffer.subarray(0, end).toString()
    if (!head.includes('101')) return fail(`the server refused the upgrade:\n  ${head.split('\r\n')[0]}`)
    if (!head.toLowerCase().includes(expect.toLowerCase())) {
      return fail('Sec-WebSocket-Accept did not match — the handshake digest is wrong')
    }
    handshaken = true
    buffer = buffer.subarray(end + 4)
  }
  const { out, rest } = decode(buffer)
  buffer = rest
  for (const f of out) {
    if (f.opcode === 0x1) {
      try {
        const m = JSON.parse(f.payload.toString())
        messages.push(m)
        // A PICTURE IS NOT ALWAYS BINARY. The protocol documents four ways to
        // send one and only `format:'rgba'` uses a binary payload; `frame.url`,
        // `video.url` and `stream.url` are text. This checker counted binary
        // opcodes only, so it failed a CONFORMING server that used a URL — told
        // an integrator their picture never arrived while the browser would have
        // painted it happily. Found by teaching the reference server the URL
        // path and running the checker at it, one iteration after shipping.
        const url = typeof m?.url === 'string' ? m.url : ''
        if (url && (m.type === 'frame' || m.type === 'video' || m.type === 'stream')) {
          frames.count += 1
          // The URL itself is the content signature: a server that keeps
          // pointing at the same picture has not changed the picture.
          frames.digests.push(url)
        }
      } catch { /* not ours */ }
    }
    else if (f.opcode === 0x2) {
      frames.count += 1
      frames.bytes += f.payload.length
      // A cheap content digest: if the picture never changes, these never change.
      frames.digests.push(createHash('sha1').update(f.payload).digest('hex').slice(0, 12))
    } else if (f.opcode === 0x9) sock.write(encode(0xa, f.payload))
  }
})

const results = []
const ok = (name, detail) => results.push({ name, pass: true, detail })
const no = (name, detail) => results.push({ name, pass: false, detail })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
function fail(msg) {
  console.error(`\n  cannot test ${url}: ${msg}\n`)
  process.exit(2)
}
sock.on('error', (e) => fail(String(e.message ?? e)))

// ── The conversation ────────────────────────────────────────────────────────
await wait(600)
if (!handshaken) fail('no HTTP upgrade — is anything listening there?')

send({ type: 'hello', studio: 'protocol-check', protocol: 1 })
await wait(1200)

const caps = messages.find((m) => m?.type === 'capabilities')
if (!caps) {
  no('handshake', "no 'capabilities' message came back after 'hello'")
  report()
}
ok('handshake', 'answered hello with capabilities')

// Shape, field by field, so a wrong type is named rather than "invalid".
const bools = ['streaming', 'promptableEvents', 'heldCommands', 'persistentWorlds']
const wrong = bools.filter((k) => caps[k] !== undefined && typeof caps[k] !== 'boolean')
  .map((k) => `${k} is ${typeof caps[k]}, must be boolean`)
if (caps.note !== undefined && typeof caps.note !== 'string') wrong.push('note must be a string')
if (wrong.length) no('shape', wrong.join('; '))
else ok('shape', bools.filter((k) => caps[k]).join(', ') || 'nothing declared beyond streaming')

const streaming = caps.streaming !== false
send({ type: 'start', worldId: 'w_protocolcheck', prompt: 'A bare room, one window, grey morning light.' })
await wait(QUIET_MS)

const before = frames.count
if (streaming) {
  if (before === 0) no('frames', `nothing arrived in ${QUIET_MS}ms after 'start' — you declared streaming`)
  else ok('frames', frames.bytes > 0 ? `${before} frames, ${Math.round(frames.bytes / 1024)}KB` : `${before} frames (by URL)`)
} else {
  ok('frames', 'streaming: false — not expected to draw')
}

/** Did the picture MOVE after we asked it to? The declaration is only worth what
 *  the pixels say. Unique digests, not frame count: a server that keeps sending
 *  the identical picture is exactly the failure being hunted. */
async function provoke(name, message, declared) {
  if (!declared) return ok(name, 'not declared — nothing promised, nothing owed')
  if (!streaming) return ok(name, 'declared, but streaming is off so there is nothing to watch')
  const mark = frames.digests.length
  send(message)
  await wait(QUIET_MS)
  const after = frames.digests.slice(mark)
  const fresh = new Set(after)
  if (after.length === 0) return no(name, `you declared it, and no frame arrived in ${QUIET_MS}ms after the message`)
  if (fresh.size === 1 && mark > 0 && frames.digests[mark - 1] === after[0]) {
    return no(name, `you declared it, but ${after.length} frames arrived and the picture never changed`)
  }
  ok(name, `${fresh.size} distinct frames after the message`)
}

// THE PAYLOAD GOES IN `value`, and these two lines used to invent their own
// field names — `prompt` for prose, `command`/`held` for input. Neither exists in
// the protocol, and `src/provider/world/websocket.ts` sendOnWire() has always put
// both kinds in `value`. So a server that read the documented field saw an event
// with nothing in it, could not move its picture, and was told by this tool that
// it had broken the one promise the tool exists to police. Measured against a
// server identical to the reference one except that it required `value`: 5 of 7
// checks, with `promptable` and `held input` failing on conforming code.
//
// The command token is one of the studio's own (`src/play/keys.ts`), not a word
// invented here, so a server that switches on the vocabulary it will actually
// receive is exercised rather than surprised.
await provoke('promptable', { type: 'event', kind: 'prompt', value: 'The window blows open. Rain comes in.' }, caps.promptableEvents === true)
await provoke('held input', { type: 'event', kind: 'command', value: 'Front' }, caps.heldCommands === true)

// `bye`, not `stop`: same class of invention as the two above. The protocol's
// word for "release the session, I am done" is `bye`, and it is the one the
// studio sends before a clean close — so a server that hangs on to a GPU until
// its socket times out is only found by sending the message it is waiting for.
send({ type: 'bye' })
await wait(300)

// ── RECONNECT, and what a resumed session is owed ───────────────────────────
//
// The studio retries an abnormal close five times with backoff and, on each
// attempt, re-sends `hello` then `start` with `resume:true`. A server that only
// ever serves ONE connection looks perfect until the first hiccup, and then the
// session is over for good — the failure arrives long after the integration
// "worked". Nothing exercised this, on either side.
sock.destroy()
await wait(400)
const second = await redial()
if (!second.handshaken) {
  no('reconnect', 'the server did not accept a second connection — one hiccup ends the session for good')
} else if (!second.caps) {
  no('reconnect', "reconnected, but no 'capabilities' came back — the studio re-sends hello on every connection")
} else {
  const resumed = second.frames > 0
  if (!resumed && streaming) no('reconnect', `reconnected and answered, but no picture in ${QUIET_MS}ms after the resumed start`)
  else ok('reconnect', `accepted a second connection, re-answered hello${streaming ? `, ${second.frames} frames` : ''}`)
}

// `persistentWorlds` is a claim about the SECOND session specifically: the same
// worldId re-entered later. Only meaningful once a reconnect has happened.
if (caps.persistentWorlds === true) {
  if (!second.handshaken) no('persistent worlds', 'declared, but the server would not take a second session at all')
  else if (streaming && second.frames === 0) no('persistent worlds', 'declared, but re-entering the same worldId drew nothing')
  else ok('persistent worlds', 'the same worldId was re-entered and served')
} else {
  ok('persistent worlds', 'not declared — nothing promised, nothing owed')
}

report()

/** Dial again the way the studio does after an abnormal close. */
async function redial() {
  const s2 = connect({ host: u.hostname, port: Number(u.port || 80) })
  const k2 = randomBytes(16).toString('base64')
  const want = createHash('sha1').update(k2 + GUID).digest('base64')
  const state = { handshaken: false, caps: null, frames: 0 }
  let buf = Buffer.alloc(0)
  s2.on('error', () => {})
  s2.on('connect', () => {
    s2.write(
      `GET ${u.pathname || '/'} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Key: ${k2}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    )
  })
  s2.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    if (!state.handshaken) {
      const end = buf.indexOf('\r\n\r\n')
      if (end === -1) return
      const head = buf.subarray(0, end).toString()
      if (!head.includes('101') || !head.toLowerCase().includes(want.toLowerCase())) return
      state.handshaken = true
      buf = buf.subarray(end + 4)
    }
    const { out, rest } = decode(buf)
    buf = rest
    for (const f of out) {
      if (f.opcode === 0x1) {
        try {
          const m = JSON.parse(f.payload.toString())
          if (m?.type === 'capabilities') state.caps = m
          const url2 = typeof m?.url === 'string' ? m.url : ''
          if (url2 && (m.type === 'frame' || m.type === 'video' || m.type === 'stream')) state.frames += 1
        } catch { /* not ours */ }
      } else if (f.opcode === 0x2) state.frames += 1
      else if (f.opcode === 0x9) s2.write(encode(0xa, f.payload))
    }
  })
  await wait(900)
  if (state.handshaken) {
    s2.write(encode(0x1, Buffer.from(JSON.stringify({ type: 'hello', studio: 'protocol-check', protocol: 1 }))))
    await wait(900)
    // `resume:true` and the SAME worldId — that pair is what persistentWorlds means.
    s2.write(encode(0x1, Buffer.from(JSON.stringify({ type: 'start', worldId: 'w_protocolcheck', resume: true, prompt: 'A bare room, one window, grey morning light.' }))))
    await wait(QUIET_MS)
  }
  s2.destroy()
  return state
}

function report() {
  const width = Math.max(...results.map((r) => r.name.length))
  console.log(`\n  ${url}\n`)
  for (const r of results) console.log(`  ${r.pass ? '✓' : '✗'} ${r.name.padEnd(width)}  ${r.detail}`)
  const bad = results.filter((r) => !r.pass)
  console.log(
    bad.length === 0
      ? '\n  Every claim this server made, it honoured.\n'
      : `\n  ${bad.length} unhonoured claim(s). A capability you declare and ignore is worse than one you do not have:\n` +
        '  the studio believes you, so every beat fires and the picture never moves.\n',
  )
  sock.destroy()
  process.exit(bad.length === 0 ? 0 : 1)
}
