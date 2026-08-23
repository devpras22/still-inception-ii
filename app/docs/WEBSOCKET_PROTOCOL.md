# WebSocket world-model protocol

How to wire your own world model into the studio. If your model can hold a
WebSocket open and push pictures down it, this is everything you need on the wire.

This document describes what `src/providers/world/websocket.ts` actually sends and
accepts. Where the two disagree, the code is right and this file is a bug.

Protocol version 1.

## The shape of it

Every message is either a JSON text frame or a binary frame. Binary frames are
pictures. JSON frames carry a `type` field.

Unknown `type` values are ignored by both sides. That is what lets either end add
messages without a version negotiation. Do not error on a message you do not
recognise.

Text that is not valid JSON is ignored, so a server that logs to its own socket
does not break the studio.

## Connecting

The user pastes a URL into Settings. `ws://` and `wss://` are accepted. An
`http://` or `https://` URL is rewritten to the matching WebSocket scheme, because
that mistake is common and the host is almost always right. Any other scheme is
rejected before a socket opens.

If the user set a key, it is appended to the query string.

```
wss://your-host/world?key=YOUR_KEY
```

Browsers cannot set headers on a WebSocket handshake, so the query string is the
only carrier that works against a server written by someone who has not read this
file. The alternative, smuggling the key through `Sec-WebSocket-Protocol`, fails
the whole connection when the server does not echo the token back, which makes a
wrong key indistinguishable from a normal server.

Three consequences you should plan for.

- Use `wss://`. The query string is inside TLS there, and in the clear otherwise.
  The studio warns the user when a key is going over plain `ws://` to a non-loopback
  host, and does not block it.
- The key lands in your access log. Rotate accordingly, and prefer scoped or
  short-lived keys.
- If the URL already has a `key` parameter, the studio leaves it alone.

A page served over `https://` cannot open a `ws://` socket at all. The browser
blocks the upgrade. Serve the studio over `http://localhost` while developing, or
put TLS in front of your socket.

Your server also has to accept the studio's origin. A WebSocket handshake is not
subject to CORS in the way `fetch` is, but many frameworks check `Origin` and
close. If connections die immediately with no message, check that first.

## Handshake

The studio speaks first, on every connection including reconnects.

```json
{"type":"hello","studio":"0.1.0","protocol":1}
```

Answer it.

```json
{"type":"capabilities",
 "streaming":true,
 "promptableEvents":true,
 "heldCommands":false,
 "persistentWorlds":false,
 "note":"events apply on the next keyframe, about 400ms"}
```

| Field | Type | Missing means | What it controls |
|---|---|---|---|
| `streaming` | bool | `true` | Whether the studio expects a picture. You answered, so it assumes you draw. |
| `promptableEvents` | bool | `false` | Whether the studio sends `prompt` and `state` events at all. |
| `heldCommands` | bool | `false` | Whether the studio sends `command` events (WASD-style input). |
| `persistentWorlds` | bool | `false` | Whether a world id can be re-entered in a later session. |
| `note` | string | absent | Shown verbatim in the studio UI. Put latency, model name, or caveats here. |

Every boolean except `streaming` defaults to false when you omit it. Declare what
you support and leave out what you do not.

Answer honestly. The studio takes your reply literally and has no way to check it.
A server that claims `promptableEvents: true` and then ignores event messages
produces the worst failure this protocol has, described under
[If you do not answer](#if-you-do-not-answer).

## Starting a session

`hello` and `start` are separate messages on purpose.

```json
{"type":"start",
 "worldId":"w_123",
 "prompt":"A rain-slicked rooftop at midnight.",
 "firstFrameUrl":"https://example.com/seed.png",
 "resume":false}
```

The capability probe sends `hello` alone and hangs up without ever sending
`start`. Put GPU allocation, model loading, and anything else that costs money
behind `start`, and a capability check costs you nothing.

In a real session the two arrive back to back. The studio does not wait for your
`capabilities` reply before sending `start`, so do not build a state machine that
expects a gap. It does wait for capabilities before sending any `event`.

`prompt` and `firstFrameUrl` are omitted when the studio has none. `resume` is
`true` when this is a reconnect for a session that was already running.

## Sending pictures

Four ways. Use whichever fits what you already have.

**Encoded image, binary frame.** Send the bytes of a PNG, JPEG, WebP, or GIF as a
binary message. The studio sniffs the magic bytes and paints it. No JSON needed.

**Image at a URL.**

```json
{"type":"frame","url":"https://cdn.example.com/f/00412.jpg"}
```

The browser fetches it, so it has to be reachable from the user's machine.

**Raw pixels.** Announce the layout, then send exactly `width * height * 4` bytes
of RGBA in the next binary message.

```json
{"type":"frame","format":"rgba","width":320,"height":180}
```

The header applies to the next binary message only. Send one header per frame.

**A media stream.**

```json
{"type":"video","url":"https://cdn.example.com/live/index.m3u8"}
```

The studio hands this to a `<video>` element, so anything the browser plays
natively works, including HLS, DASH, MP4, and WebM. This is far cheaper than
pushing frames through JSON, so prefer it when you already have a stream.
`{"type":"stream","url":"…"}` is accepted as a synonym.

A legacy inline header is also accepted for raw pixels, with no preceding JSON:
one byte `0x01`, then width as a little-endian uint16, then height as a
little-endian uint16, then the RGBA bytes. It exists so older Alakazam-runtime
servers work unchanged. New servers should use the JSON header.

A binary message in none of these formats is dropped, and the studio logs one
console warning naming the byte count.

## Receiving events

An authored beat from the user's state machine arrives as one message.

```json
{"type":"event","kind":"state","value":"The alarm starts.","stateId":"cellar"}
```

| `kind` | Meaning | Sent when |
|---|---|---|
| `prompt` | Prose. A description of what the world should look like now. | `promptableEvents` |
| `state` | Prose, plus the state id the machine just entered. | `promptableEvents` |
| `command` | A discrete input token such as `Front`, `Left`, `Look up`. Arrives at input rate. | `heldCommands` or `promptableEvents` |

`stateId` is present when the studio knows which state the beat belongs to.

The gating is strict. If you declared `promptableEvents: false`, the studio never
sends you a `prompt` or a `state` event, and it warns the user that their state
machine cannot reach the picture. A model that takes movement input but no prose
should declare `heldCommands: true` and `promptableEvents: false`, and it will
still receive commands.

## Ending

Either side can end it.

```json
{"type":"ended","reason":"out of credit"}
```

The studio stops, reports your reason to the user, and does not reconnect.

```json
{"type":"error","message":"prompt exceeded 1000 characters"}
```

Logged to the console and otherwise survivable. The session continues. A `detail`
field is read when `message` is absent. Use `ended` for anything fatal.

During a capability probe, `error` and `ended` are both terminal. The probe stops
and reports no capabilities, with your text as the reason. Do not answer `hello`
with an error unless you mean the endpoint is unusable.

Before a clean shutdown the studio sends `{"type":"bye"}` on a best-effort basis,
then closes with code 1000. Treat `bye` as permission to release the session
instead of waiting for a socket timeout.

## Close codes

| Code | Studio behaviour |
|---|---|
| 1000 | Session over. No reconnect. The close reason is shown to the user. |
| 1003, 1008, 4401, 4403 | Refused on purpose. No reconnect. The user is told to check the key and the URL path. |
| anything else | Reconnect with backoff. |

Use 1008 or 4401 for a bad key. Retrying a rejected key only burns your rate
limit, so the studio does not.

## Reconnecting

An abnormal close is retried up to five times, with jittered exponential backoff
of roughly 0.5s, 0.9s, 1.6s, 2.9s, and 5.2s. The attempt counter resets whenever
any message arrives, so a server that talks but flaps keeps earning retries. A
second budget of 20 reconnects per session does not reset, which stops a server
that accepts, says one word and hangs up from looping forever.

On a reconnect the studio sends `hello`, then `start` with `resume: true`, then
replays the most recent `state` event and nothing else. Stale prompts and stale
movement commands are dropped on purpose. Replaying a ten-second-old "he draws the
knife" is worse than replaying nothing.

Capabilities you declared once are remembered across a reconnect. A silent
reconnect does not downgrade them, because you declared them about your server
rather than about that one socket.

## If you do not answer

The studio does not fail. It waits, then infers.

- `streaming` becomes true only if a picture actually arrived.
- `promptableEvents`, `heldCommands`, and `persistentWorlds` are all false.
- The inferred capabilities carry a `note` saying they were guessed and telling the
  user to make the server answer `hello`.

False is the deliberate guess for `promptableEvents`. A backend that streams
pretty frames while ignoring authored events looks identical to one that works.
Transitions fire, the HUD updates, and the picture ignores all of it. Guessing
true costs the user an hour of confusion. Guessing false costs one dismissible
warning. Send a `capabilities` reply and neither happens.

## Timings

| What | Budget |
|---|---|
| Socket open | 8s, then the studio gives up and reports a timeout |
| Reply to `hello` | 2.5s before the studio starts inferring |
| Whole capability probe | 5s, from open to verdict |

The probe closes the socket as soon as it has an answer, so answering `hello`
promptly also ends the connection promptly.

## The `protocol` setting

Settings offers three values. Leave it on `auto` unless you know otherwise.

| Value | Behaviour |
|---|---|
| `auto` | Sends `hello`. If nothing answers within 2.5s, also sends `{"type":"init","modelId":"…"}` for the older Alakazam runtime, then waits again. |
| `raw` | Sends `hello` only. Never probes for the older dialect. |
| `alakazam-ws` | Sends `init` first, then `hello`. |

The older Alakazam runtime answers `init` with `{"type":"ready","config":{…}}`. In
that dialect the studio reads `config.actionNames`, `config.numActions`,
`config.promptableEvents`, `config.persistentWorlds`, and `config.name`. It maps a
`command` event onto `{"type":"action","action":<index>}` when the token matches an
entry in `actionNames`, case-insensitively. `promptableEvents` stays false there
unless the config explicitly opts in, because that runtime takes action integers
and has no channel for prose.

If you are writing a new server, ignore this dialect entirely and answer `hello`.

## Checking your server

```sh
npm run protocol-check -- ws://localhost:8765
```

It connects the way the studio does and reports, claim by claim, what your server
actually did — the handshake, the shape of every field you declared, whether a
picture arrives, and the one the studio cannot check for itself:

```
  ✓ handshake   answered hello with capabilities
  ✓ shape       streaming, promptableEvents, heldCommands
  ✓ frames      39 frames, 2194KB
  ✗ promptable  you declared it, but 40 frames arrived and the picture never changed
  ✗ reconnect   the server did not accept a second connection — one hiccup ends the session for good
```

That last line is the failure described under [If you do not answer](#if-you-do-not-answer),
caught before it reaches anyone's world. The studio takes your capabilities reply
literally, so a server that claims `promptableEvents` and ignores events produces
a world where every beat fires, the HUD updates, and the picture never moves. This
sends a prompt and watches whether your pixels change.

Exit code is `0` when every claim held, `1` when one did not, and `2` when nothing
was listening. Zero dependencies, so you can run it against your server before you
have wired up anything else.

## A server you can run

Both examples below draw a flat colour that shifts every time an event lands.
Nothing renders a world. They exist so you can watch the studio connect, read your
capabilities, and deliver beats, before you wire any of it to a model.

Point Settings at `ws://localhost:8765` after starting one.

Both were run on 2026-07-30 against a client that speaks this document, and both
passed the same ten checks: a `capabilities` reply, silence until `start`, a
correctly sized RGBA payload behind its layout header, a visible change on a
`state` event, a `command` event accepted, and a clean close on `bye`. Copy them
as they are before you change anything.

### Python

```python
# world_echo.py
#   pip install 'websockets>=13'
#   python world_echo.py
import asyncio
import json

from websockets.asyncio.server import serve

WIDTH, HEIGHT = 160, 90

CAPABILITIES = {
    "type": "capabilities",
    "streaming": True,
    "promptableEvents": True,
    "heldCommands": True,
    "persistentWorlds": False,
    "note": "echo server: a flat colour, no model behind it",
}


async def session(sock):
    colour = [40, 60, 90]
    painter = None

    async def paint():
        while True:
            # One layout header, then exactly WIDTH * HEIGHT * 4 bytes of RGBA.
            await sock.send(json.dumps(
                {"type": "frame", "format": "rgba", "width": WIDTH, "height": HEIGHT}
            ))
            await sock.send(bytes(colour + [255]) * (WIDTH * HEIGHT))
            await asyncio.sleep(0.1)

    try:
        async for raw in sock:
            msg = json.loads(raw)
            kind = msg.get("type")
            if kind == "hello":
                # Skip this and the studio infers promptableEvents: false
                # and warns the user that their state machine is invisible.
                await sock.send(json.dumps(CAPABILITIES))
            elif kind == "start":
                print("start", msg.get("worldId"), repr(msg.get("prompt"))[:80])
                if painter is None:
                    painter = asyncio.create_task(paint())
            elif kind == "event" and msg.get("value"):
                # The payload is in `value`, for every kind. Reacting to the
                # envelope instead looks identical and is how a server ends up
                # ignoring the thing it was sent.
                print("event", msg.get("kind"), msg.get("value"))
                colour[:] = [(c * 7 + 90) % 256 for c in colour]
            elif kind == "bye":
                break
    finally:
        if painter is not None:
            painter.cancel()


async def main():
    async with serve(session, "localhost", 8765):
        print("world model on ws://localhost:8765")
        await asyncio.Future()


asyncio.run(main())
```

### Node

```js
// world-echo.mjs
//   npm i ws
//   node world-echo.mjs
import { WebSocketServer } from 'ws'

const WIDTH = 160
const HEIGHT = 90

const CAPABILITIES = {
  type: 'capabilities',
  streaming: true,
  promptableEvents: true,
  heldCommands: true,
  persistentWorlds: false,
  note: 'echo server: a flat colour, no model behind it',
}

const server = new WebSocketServer({ port: 8765 })

server.on('connection', (sock) => {
  let colour = [40, 60, 90]
  let timer = null

  const paint = () => {
    sock.send(JSON.stringify({ type: 'frame', format: 'rgba', width: WIDTH, height: HEIGHT }))
    const pixels = Buffer.alloc(WIDTH * HEIGHT * 4)
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = colour[0]
      pixels[i + 1] = colour[1]
      pixels[i + 2] = colour[2]
      pixels[i + 3] = 255
    }
    sock.send(pixels)
  }

  sock.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    if (msg.type === 'hello') sock.send(JSON.stringify(CAPABILITIES))
    else if (msg.type === 'start' && !timer) timer = setInterval(paint, 100)
    else if (msg.type === 'event' && msg.value) colour = colour.map((c) => (c * 7 + 90) % 256)
    else if (msg.type === 'bye') sock.close(1000, 'client said bye')
  })

  sock.on('close', () => clearInterval(timer))
})

console.log('world model on ws://localhost:8765')
```

## Before you ship your server

- Answer `hello` with `capabilities`. Everything else is downstream of that.
- Read the payload out of `value`. Every kind carries it there, and a server that
  switches on `type` alone cannot tell a beat from a stray message.
- Declare `promptableEvents` only if event messages change what you draw.
- Do nothing expensive until `start`.
- Handle `resume: true` on `start`, or accept that a reconnect restarts the world.
- Close with 1008 or 4401 on a bad key so the studio stops retrying.
- Send `ended` with a reason the user can read when you stop.
- Ignore message types you do not recognise.
