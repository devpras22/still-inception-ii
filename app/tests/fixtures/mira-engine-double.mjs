#!/usr/bin/env node
// A stand-in for the MIRA engine `mira-mini play` starts, speaking its dialect
// and nothing else, so the bridge in examples/world-mira.mjs can be tested
// without 5 GB of weights and a laptop GPU.
//
// It is a DOUBLE, not a model. It proves one thing — that the bridge translates
// the two dialects correctly in both directions — and it is deliberately unable
// to prove anything about MIRA itself: not the frame rate, not whether the keys
// it is handed steer a car anywhere sensible, not whether a real engine accepts
// the same `rules`. Those are read off the real thing or not claimed.
//
// The dialect it implements is read from the engine's own server (the engine's
// `@app.websocket("/ws")` handler) and `server/rocket_league/config.py`:
//
//   client -> engine   {"type":"start","rules":{…}}   MUST be the first message
//                      {"type":"actions","held":{"0":["W", …]}}
//                      {"type":"stop"}
//   engine -> client   {"type":"ready","meta":{…}}
//                      {"type":"frame","fi":N,"views":[l0,l1,l2,l3],"ms":F}
//                        followed by ONE binary message: the four seats' JPEGs
//                        concatenated, in that order
//                      {"type":"ended","reason":"…"} / {"type":"error","detail":"…"}
//
// STRICT ON PURPOSE, in two places that are the whole point of the test:
//   · a first message that is not `start` is answered with the engine's own
//     error text, so a bridge that opens with the studio's `hello` is caught
//   · the picture changes only while seat 0 actually holds a key, so a bridge
//     that declares heldCommands and fails to translate a control token is
//     caught by the checker rather than by a user
//
//   node tests/fixtures/mira-engine-double.mjs [port]      (0 = OS picks)

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const PORT = Number(process.argv[2] ?? 0)
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Two real JPEGs, 64x36, one blue and one orange: a picture that changes is a
 *  picture a decoder can tell apart, not a byte that differs. */
const IDLE = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAkAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDh6KKK9w88KKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigD/2Q==',
  'base64',
)
const MOVING = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAkAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCrRRRXyh9iFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQB//9k=',
  'base64',
)
/**
 * The other three seats: the cars the model imagines.
 *
 * Deliberately FAT — six times seat 0 — so that a bridge which forwards the
 * whole concatenation instead of slicing seat 0 out of it is visible as a byte
 * count rather than invisible. A browser handed the concatenation paints the
 * first picture and silently ignores the rest, so the wrong behaviour looks
 * exactly like the right one on screen.
 */
const OTHER = Buffer.alloc(4096, 0x2e)

function encodeFrame(opcode, payload) {
  const len = payload.length
  let head
  if (len < 126) head = Buffer.from([0x80 | opcode, len])
  else if (len < 65536) {
    head = Buffer.alloc(4)
    head[0] = 0x80 | opcode
    head[1] = 126
    head.writeUInt16BE(len, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x80 | opcode
    head[1] = 127
    head.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([head, payload])
}

function decodeFrames(buffer) {
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

const server = createServer((_req, res) => {
  res.writeHead(426, { 'Content-Type': 'text/plain' })
  res.end('websocket only\n')
})

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  if (!key) return socket.destroy()
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${createHash('sha1').update(key + GUID).digest('base64')}\r\n\r\n`,
  )

  let started = false
  let timer = null
  let held = []
  let fi = 0
  let pending = Buffer.alloc(0)
  const sendText = (v) => socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(v))))

  const paint = () => {
    const seat0 = held.length > 0 ? MOVING : IDLE
    const seats = [seat0, OTHER, OTHER, OTHER]
    sendText({ type: 'frame', fi: fi++, views: seats.map((s) => s.length), ms: 76.0 })
    socket.write(encodeFrame(0x2, Buffer.concat(seats)))
  }
  const stop = () => {
    if (timer) clearInterval(timer)
    timer = null
  }

  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk])
    const { frames, rest } = decodeFrames(pending)
    pending = rest
    for (const f of frames) {
      if (f.opcode === 0x8) return (stop(), socket.end())
      if (f.opcode === 0x9) {
        socket.write(encodeFrame(0xa, f.payload))
        continue
      }
      if (f.opcode !== 0x1) continue
      let m
      try {
        m = JSON.parse(f.payload.toString('utf8'))
      } catch {
        continue
      }
      if (!started) {
        if (m.type !== 'start') {
          sendText({ type: 'error', detail: 'first message must be start' })
          stop()
          socket.end()
          return
        }
        started = true
        console.log('start', JSON.stringify(m.rules ?? {}))
        sendText({ type: 'ready', meta: { n_players: 4, model: 'double' } })
        timer = setInterval(paint, 90)
        continue
      }
      if (m.type === 'actions') {
        held = Array.isArray(m.held?.['0']) ? m.held['0'] : []
        console.log('held', JSON.stringify(held))
      } else if (m.type === 'stop') {
        stop()
        sendText({ type: 'ended', reason: 'stopped' })
        socket.end()
      }
    }
  })

  socket.on('close', stop)
  socket.on('error', stop)
})

server.listen(PORT, () => console.log(`mira engine double on ws://localhost:${server.address()?.port}/ws`))
