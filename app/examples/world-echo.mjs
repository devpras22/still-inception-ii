#!/usr/bin/env node
// A world model you can actually run: node examples/world-echo.mjs
//
// It speaks the protocol in docs/WEBSOCKET_PROTOCOL.md and draws a flat colour
// that changes on every authored beat. There is no model behind it — the point
// is to prove the wire contract end to end before you put a real one there.
//
// ZERO DEPENDENCIES, on purpose. The protocol doc used to carry this as a
// copy-paste block needing `npm i ws` first, so the first thing anyone
// integrating their own model had to do was install a package to read an
// example. The WebSocket handshake and framing are ~80 lines of the standard
// library, so they are written out below rather than imported.
//
//   node examples/world-echo.mjs [port]     (default 8765)
//
// Then in the studio: Settings -> World model -> WebSocket endpoint ->
// ws://localhost:8765 -> Test connection -> Save -> play any world.

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const PORT = Number(process.argv[2] ?? 8765)
/**
 * Which of the protocol's picture paths to demonstrate.
 *
 *   rgba  (default)  announce a layout, then send raw pixels — what this server
 *                    always did, and the path with the most ways to get wrong.
 *   url              serve the picture over the same HTTP listener and send
 *                    {"type":"frame","url":…}. Two of the four documented ways
 *                    to send a picture, in one file, so an integrator can see
 *                    both wired up rather than read about the second one.
 *
 *   node examples/world-echo.mjs 8765 url
 */
const PICTURE = process.argv[3] === 'url' ? 'url' : 'rgba'
/**
 * `drop` — cut the FIRST connection abnormally, once, after a few frames.
 *
 * The studio retries an abnormal close five times with backoff and re-sends
 * `hello` then `start` with `resume:true`. That behaviour is documented at
 * length in `src/provider/world/websocket.ts` and nothing exercised it, so a
 * regression in it would surface as somebody's session dying on the first
 * network blip — days after the integration looked fine. This mode makes the
 * blip happen on demand.
 *
 *   node examples/world-echo.mjs 8765 rgba drop
 */
const DROP = process.argv[4] === 'drop' || process.argv[4] === 'refuse'
/**
 * `refuse` — drop the session AND then turn the lights off for a while.
 *
 * `drop` lets the very next connection straight back in, so exactly one retry
 * ever happens and the studio's BACKOFF SCHEDULE (5 attempts, 0.5s→8s, jittered)
 * cannot be observed. This mode refuses every connection for REFUSE_MS after the
 * drop, which is what a restarting server actually looks like, and makes the
 * gaps between the studio's retries measurable.
 */
const REFUSE = process.argv[4] === 'refuse'
const REFUSE_MS = Number(process.argv[5] ?? 6000)
let refuseUntil = 0
let dropped = false
/** A 1x1 PNG. The URL path is about the MESSAGE, not the image. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const WIDTH = 160
const HEIGHT = 90
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
let frameNo = 0

const CAPABILITIES = {
  type: 'capabilities',
  streaming: true,
  promptableEvents: true,
  heldCommands: true,
  persistentWorlds: false,
  note: 'echo server: a flat colour, no model behind it',
}

// ── Minimal RFC 6455 framing ─────────────────────────────────────────────────

/** Encode one server->client frame. Server frames are never masked. */
function encodeFrame(opcode, payload) {
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

/**
 * Pull complete frames out of a rolling buffer, returning what could be decoded
 * and whatever bytes are left over. TCP does not respect message boundaries, so
 * a frame can and will arrive in pieces.
 */
function decodeFrames(buffer) {
  const frames = []
  let offset = 0
  for (;;) {
    if (buffer.length - offset < 2) break
    const first = buffer[offset]
    const second = buffer[offset + 1]
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
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

// ── The world ────────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  // The URL picture path needs somewhere for the browser to FETCH the picture
  // from, and the protocol says "it has to be reachable from the user's
  // machine" — so it is served from the same listener the socket upgrades on,
  // with CORS open because the studio is on another origin.
  if (req.url?.startsWith('/frame.png')) {
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    })
    res.end(PNG)
    return
  }
  res.writeHead(426, { 'Content-Type': 'text/plain' })
  res.end('This endpoint speaks WebSocket. Point the studio at it.\n')
})

server.on('upgrade', (req, socket) => {
  // ONE LINE PER DECISION. A browser-side wrapper only sees the sockets the page
  // routes through it — two passes were spent believing the studio
  // had stopped retrying when in fact the instrument had stopped watching. The
  // server sees every connection that reaches it, by definition, so it says so.
  if (REFUSE && Date.now() < refuseUntil) {
    console.log(`upgrade refused ${Date.now()}`)
    socket.destroy()
    return
  }
  console.log(`upgrade accepted ${Date.now()}`)
  const key = req.headers['sec-websocket-key']
  if (!key) return socket.destroy()
  const accept = createHash('sha1').update(key + GUID).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )

  let colour = [40, 60, 90]
  let timer = null
  let pending = Buffer.alloc(0)

  const sendText = (value) => socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(value))))
  const sendBinary = (buf) => socket.write(encodeFrame(0x2, buf))

  const paint = () => {
    if (PICTURE === 'url') {
      // A cache-busting query, or the browser paints the first frame forever.
      sendText({ type: 'frame', url: `http://localhost:${PORT}/frame.png?f=${frameNo++}` })
      return
    }
    sendText({ type: 'frame', format: 'rgba', width: WIDTH, height: HEIGHT })
    const pixels = Buffer.alloc(WIDTH * HEIGHT * 4)
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = colour[0]
      pixels[i + 1] = colour[1]
      pixels[i + 2] = colour[2]
      pixels[i + 3] = 255
    }
    sendBinary(pixels)
  }

  const stop = () => {
    if (timer) clearInterval(timer)
    timer = null
  }

  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk])
    const { frames, rest } = decodeFrames(pending)
    pending = rest
    for (const frame of frames) {
      if (frame.opcode === 0x8) {
        stop()
        socket.end()
        return
      }
      if (frame.opcode === 0x9) {
        socket.write(encodeFrame(0xa, frame.payload))
        continue
      }
      if (frame.opcode !== 0x1) continue
      let message
      try {
        message = JSON.parse(frame.payload.toString('utf8'))
      } catch {
        continue
      }
      console.log('<<', JSON.stringify(message).slice(0, 160))
      if (message.type === 'hello') sendText(CAPABILITIES)
      else if (message.type === 'start' && !timer) {
        timer = setInterval(paint, 100)
        // The blip: cut this socket abnormally, once, mid-session. Code 1006 is
        // what an abrupt drop looks like to the client — NOT 1000, which the
        // studio correctly treats as "we are done" and does not retry.
        if (DROP && !dropped) {
          dropped = true
          setTimeout(() => { clearInterval(timer); timer = null; refuseUntil = Date.now() + REFUSE_MS; socket.destroy() }, 1500)
        }
      }
      // READ THE PAYLOAD, do not just count the envelope. A beat's prose and a
      // held command both arrive in `value`; reacting to any `event` at all
      // looks identical and teaches the opposite of the protocol. It also hid a
      // real bug: this repo's own conformance checker was sending the prose
      // under a field name the protocol does not define, and nothing noticed
      // because the reference server never looked.
      else if (message.type === 'event' && message.value) colour = colour.map((c) => (c * 7 + 90) % 256)
      else if (message.type === 'bye') {
        stop()
        socket.end()
      }
    }
  })

  socket.on('close', stop)
  socket.on('error', stop)
})

server.listen(PORT, () => {
  // PORT 0 asks the OS for a free one. A harness that hardcodes a port collides
  // with whatever else happens to be listening — three unrelated processes were
  // squatting this range on the machine that wrote this, including a port a test
  // had used the day before. Print what we got so a caller can read it.
  const bound = server.address()?.port ?? PORT
  console.log(`world model on ws://localhost:${bound}`)
})
