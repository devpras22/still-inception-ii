# Providers

Two independent choices, set in **Settings** and stored in this browser's
`localStorage` under `alakazam-studio:providers:v1`.

- **World model** draws the world and reacts to authored events.
- **LLM** writes and edits world graphs from plain language.

They do not depend on each other. A local Ollama model can author a world that a
Reactor session renders, and a mock renderer can display a world that OpenAI
wrote.

A studio configured before providers existed keeps working. The old
`alakazam-studio:config:v1` entry, holding an API base, an embed host and a key,
is folded into the `alakazam` provider on first load and that provider is selected
if the key was set. The old entry is left in place so a downgrade does not lose it.

No key is read from an environment variable. `VITE_` variables are compiled into
the bundle and served to every visitor, so a key placed there is published rather
than configured. Keys are typed into Settings and kept in the browser.

---

# World-model providers

## mock

The default. No key, no network, no account.

It draws onto a canvas: the world's opening prompt, the state the machine is
currently in, a scrolling log of every event the studio has pushed, and a
perspective grid that moves when a held command lands. A state change flashes the
horizon. Any event flashes the border. You can watch beats arrive.

**Capabilities.** `streaming: true`, `promptableEvents: true`, `heldCommands: true`,
`persistentWorlds: false`.

Those are honest rather than flattering. Authored beats really do change the
picture, which is the point: you can build and drive an entire state machine
offline, then swap in a real backend and only then find out whether it keeps the
same promise. What the mock does not do is generate video. It draws text and a
grid, its capability note says so, and it persists nothing between sessions.

**Setup.** None.

## reactor

Your own Reactor account and key, called directly from the browser. No Alakazam
account involved.

**Getting a key.**

1. Sign up at <https://www.reactor.inc>.
2. Open the Dashboard.
3. Go to **API Keys** and create one. It looks like `rk_…`.
4. Paste it into Settings, under the Reactor world provider.

Self-serve, with per-second pricing published on their site. The key is a secret.
It bills your account, and it is stored in this browser where any script on the
page can read it. Use a machine you control.

**How the studio talks to it.** The API base is `https://api.reactor.inc`, plain
HTTPS. A session starts by minting a short-lived JWT with `POST /tokens`,
authenticated with the `Reactor-API-Key` header. Measured on 2026-07-30, that
endpoint answers browser preflights and allows the header, so the mint works from
a page with no proxy in between.

The provider drives `lingbot-world-2`, Reactor's navigable world model, which
takes live prompt steering and WASD-style movement. That is the shape an authored
state graph needs, so the model is pinned in code rather than left as another
Settings field to get wrong.

**Mode.** Sessions run in one of two modes, set in Settings and fixed for the life
of a session.

- `adventure`, the default, gives the player direct control. Authored events layer
  on top. `heldCommands` is true.
- `directing` hands the wheel to the graph. Authored command beats still reach the
  model, they just arrive from the state machine instead of a keypress, so the
  studio reports `heldCommands: false` and offers no player WASD.

Either way `persistentWorlds` is false. A Reactor session is a GPU session, not a
stored world. The graph is persisted by this studio, never by Reactor.

**How frames get onto the page.** Minting a token is HTTP and is implemented here.
The video rides a WebRTC transport whose signaling is not publicly documented, and
only `@reactor-team/js-sdk` speaks it. That SDK is a declared dependency and
`src/main.tsx` registers it at boot, so `probe()` reports `streaming: true` as soon
as your key mints.

If you strip the registration out, `probe()` mints a 60-second token to prove the
key is real and then reports `streaming: false` with a note naming the missing
runtime — the key is fine, the transport is absent. That is the seam that keeps
the SDK swappable.

Your options:

1. Nothing — this is the default. `@reactor-team/js-sdk` ships as a dependency and
   `src/main.tsx` already registers it, dynamically imported so it costs nothing to
   anyone using a different provider. The registration looks like this, and you can
   point it at a different runtime by editing that one line:

   ```ts
   import { Reactor } from '@reactor-team/js-sdk'
   import { registerReactorRuntime } from './providers/world/reactor'

   registerReactorRuntime((options) => new Reactor(options))
   ```

   Without editing studio source, load an SDK build from a script tag in
   `index.html` and publish it as `globalThis.__REACTOR_SDK__`, either a factory or
   an object with a `Reactor` constructor. The provider picks up either.

2. Run a gateway that holds the Reactor session and re-broadcasts frames over the
   protocol in [WEBSOCKET_PROTOCOL.md](WEBSOCKET_PROTOCOL.md), then point the
   `websocket` provider at your gateway. No SDK in the browser. The provider
   exports `mintReactorToken()` for exactly this, with `baseUrl` pointed at your
   own host.

3. Use the `alakazam` provider, which mounts a runtime iframe carrying its own
   transport.

**Details that bite once streaming is on.**

- Prompts are cut at 1000 characters. Longer ones come back as a `command_error`
  you would never see.
- Command tokens map onto Reactor's three drive axes. `front`/`back`/`left`/`right`
  and `w`/`a`/`s`/`d` become movement, `look_left`/`look_right`/`q`/`e` become
  horizontal look, `look_up`/`look_down` vertical. `idle`, `none`, `stop` and
  `still` clear all three. Anything else throws, because an authored beat aimed at
  a control the model does not have is a bug worth seeing.
- A first-frame image is fetched by the studio page, so it has to be same-origin or
  CORS-open. A URL that opens fine in a new tab can still fail here.
- Closing a session terminates it rather than disconnecting recoverably. A
  recoverable disconnect keeps the GPU, and the meter, alive for another 30
  seconds after the user has walked away.

**What else can go wrong.** Reactor allocates GPUs per account and per model, and
the ceiling moves between hours. A session that sits waiting is usually a dry
fleet rather than a broken key. A rejected key surfaces in Settings as a failed
probe with the reason attached, and a mint failure names the status: 401 or 403 is
the key, 402 is credit, 429 is rate limiting.

## websocket

Any endpoint speaking the protocol in
[WEBSOCKET_PROTOCOL.md](WEBSOCKET_PROTOCOL.md). This is the path for a model you
host yourself, a colleague's research server, or a rig on your LAN.

**Setup.**

1. Start your server.
2. Open Settings and select the WebSocket world provider.
3. Enter the URL, `ws://` or `wss://`.
4. Enter a key only if your server wants one. Most self-hosted servers do not.
5. Leave the protocol setting on `auto` unless you know otherwise. `auto` probes
   and adapts, `raw` speaks the plain protocol documented here, and `alakazam-ws`
   forces the hosted dialect.
6. The studio probes on save and prints the capability reply.

A browser page served over `https://` cannot open a `ws://` socket. Serve the
studio over plain `http://` for local work, or terminate TLS in front of your
socket and use `wss://`.

**Capabilities.** Whatever your server reports in its capability reply. The studio
takes that answer literally. If you claim `promptableEvents: true` and then ignore
event messages, the studio has no way to tell and the user gets no warning, so
report honestly.

A server that never sends a capability reply is not treated as an error. The
studio infers conservatively. Streaming becomes true only once a frame actually
arrives, and `promptableEvents` stays **false**. Claiming events work when they do
not is the failure this whole system exists to prevent, so silence is read as "no"
rather than as "probably fine".

The probe sends `hello` and never sends `start`, so a server that renders on
demand costs nothing to check and also shows `streaming: false` at probe time. The
inferred note says so. Press Play to find out.

### A world model on your own machine

The `websocket` provider is the local path too. There is no separate provider for
it and there does not need to be one: a model running on your laptop and a model
running in someone's cluster are the same conversation over the same socket, and
the studio only ever knew about the socket.

What a local runtime owes the studio is small enough to list.

1. Answer `{"type":"hello"}` with `{"type":"capabilities",…}`.
2. Do the expensive part on `{"type":"start"}`, never before. The capability probe
   sends `hello` alone and hangs up, which is the whole reason they are two
   messages: opening Settings must not spin up a GPU.
3. Send a picture, by any one of the four documented routes.
4. Take `{"type":"event","kind":…,"value":…}` and honour whatever you declared.
5. Close on `bye`; say `ended` with a reason when you stop.
6. Accept a second connection, because the studio reconnects.

`npm run protocol-check -- ws://localhost:8765` reports, claim by claim, which of
those you actually did.

**A diffusion world model on your own machine.** `examples/world-doom.py` loads
an ONNX denoiser trained on Doom deathmatch and generates every frame it shows:
the last four frames, the last four actions and a top-down conditioning map go
in, the next 64x64 frame comes out. No renderer.

```sh
pip install onnxruntime numpy 'websockets>=13'
python examples/world-doom.py --weights /path/to/weights   # --device auto|metal|cpu
```

**Capabilities.** `streaming: true`, `heldCommands: true`, `promptableEvents:
false`. The model takes a discrete action per frame and no prose at all, so the
studio shows its standing warning and your authored beats will not reach the
picture. Driving does: W walks, A/D turn, the arrows strafe, space fires.

**Rate, measured.** On Apple silicon the bridge runs the graph through CoreML by
default and generated **10.1 frames per second end to end** — denoise, encode and
socket included — at the default three denoising steps. The same bridge with
`--device cpu`, alone, on the same machine in the same minute: **0.07 fps**.

That gap is bigger than the 6.6x the per-step numbers predict (23.6 ms on CoreML
against 156 ms on the CPU) and the reason is worth knowing before you quote
either figure: the CPU path competes for the same cores as your browser and
everything else you have open, and the machine these were taken on was a working
laptop under load. On an idle machine the CPU path is a slideshow you can steer;
on a busy one it stops being playable, while the Metal path barely moves.

The single knob that matters is the CoreML **model format**, not the compute
units — `MLProgram` is 6x faster than the default, and the GPU-only setting is
50x *slower* than the CPU. The bridge picks the one configuration worth running
and exposes no flag for the others; `build_session` in the file carries the full
table. First boot spends about 9s letting CoreML compile the graph and caches the
result, so later boots take about a second.

**Weights are not included and are not downloaded for you.** The model this
bridge was built against currently publishes **no licence**, so this page does
not yet tell you where to get it — until a licence is set, "download this" is not
something an Apache-2.0 project can ask of you. Point `--weights` at a directory
holding `denoiser.onnx` and `init_state.json` that you obtained yourself.

**The arena is generated, not a Doom level.** The conditioning map is a required
input, and the published weights ship no map, so the bridge builds a walled room
with four pillars and dead-reckons the player through it. That is off the
training distribution: expect a corridor that responds to your movement rather
than a faithful level.

**MIRA Mini.** A neural world model of car soccer that runs on Apple silicon or a
CUDA GPU with no account and no cloud. It has its own dialect rather than this
one, so `examples/world-mira.mjs` bridges the two:

```sh
pip install alakazam-mira-mini
mira-mini play                    # UI on :8770, engine on :8771
node examples/world-mira.mjs      # bridge on ws://localhost:8765
```

Then point Settings at `ws://localhost:8765`.

**Capabilities.** `streaming: true`, `heldCommands: true`, `persistentWorlds:
false`, and — the one that matters — **`promptableEvents: false`**. The engine's
only input is a set of held keys; it has no channel for prose at all. Your state
machine will run, and your authored beats will not reach the picture, so the
studio shows its standing warning. Driving works: the studio's control tokens are
mapped onto the engine's keys, and `look_up`/`look_down` are dropped rather than
approximated, because a car has no camera pitch.

Expect about 11 fps of generated steps on a 2021 M1 Pro, running the 364M model at
2 diffusion steps. A discrete GPU running the 1B model is a different number.

**What this repository ships, and what it does not.** The bridge is ours and
carries this repository's Apache-2.0 licence. The runtime is installed by you from
PyPI, and the weights are downloaded by that runtime from its own repository under
its own terms. **MIRA Mini's weights are CC BY-NC-SA — non-commercial.** Nothing
here grants you any right over them, and no weights, no runtime and no provider
code are vendored in this repository. Point the bridge at a different local engine
and none of that applies.

### Two worlds written for these models

Both local models declare `promptableEvents: false`, and a world authored the
usual way — prose beats carrying the scene forward — looks correct in the editor
and does nothing on screen against either of them. So this repository ships one
example world per model, written to the constraint rather than around it:

| File | Model | Shape |
| --- | --- | --- |
| `examples/doom-arena.sc.ts` | `world-doom.py` | a corridor: drive out, arrive, stop |
| `examples/mira-pitch.sc.ts` | `world-mira.mjs` | a loop: run at the ball, bring it back |

The division of labour is the lesson in both. **You** drive, the **model** paints
what the place looks like from there, and the **studio** decides which state you
are in and when you arrived — over the picture, rather than through the model. So
every transition lands on `see.moving(...)` or `see.still(...)`: signals computed
from the frames themselves, needing no prompt and no vision key.

Two details that do not survive being copied between them. The motion thresholds
DIFFER on purpose (a car at speed moves far more of the frame per sample than a
walking camera, so mira-pitch needs 22 where doom-arena needs 14 — reuse the
other's constant and the transition fires on the first twitch of the wheel), and
the graph shapes differ because the vocabularies do: MIRA's car has a reverse, so
its world can ask you to come back, while the Doom model has none and asking
would mean turning all the way around.

`tests/unit/local-worlds.test.ts` compiles both under the full doctrine and pins
those properties, including that no authored hotkey claims a driving key.

## alakazam

The hosted path, unchanged from before this studio was opened up. Play mints a
short-lived session token from `/v1/sessions/token` and mounts the vendor runtime
in an iframe. Choosing it also moves world storage from this browser to the hosted
API, which is what brings lint, validate and the hosted agent with it.

**Setup.**

1. Get a secret key (`sk_live_…` or `sk_test_…`) with `worlds:read`,
   `worlds:write`, and `sessions:mint`.
2. Open Settings and select the Alakazam world provider.
3. Set the API base (`https://api.alakazam.gg`) and the embed host
   (`https://play.alakazam.gg`), or point both at a local stack.

**Capabilities.** All four true. Streams frames, accepts authored events, accepts
held commands, and persists worlds.

**One caveat behind that `promptableEvents: true`.** Your authored states, events
and held input do drive the picture, because the graph lives in the API and the
embed executes it. What this backend cannot do is take a beat pushed from the
studio into a session that is already running. The runtime exposes no inbound
channel, so an edit made mid-play changes nothing on screen. Save the graph and
restart the session to see it.

A cross-origin `postMessage` into a frame with no listener looks exactly like a
delivered one, so the provider refuses to report a success it cannot confirm.
`ALAKAZAM_SUPPORTS_LIVE_PUSH` is exported as the machine-readable form of this
paragraph, so the UI can grey out a live-push control rather than offer a button
that lies.

**Probing does not cost a play.** Minting is metered, so the probe never mints. It
reads `GET /v1/usage`, and if the key is scoped to worlds and sessions but not
usage, it falls back to a single-world read before calling the key dead.

**What can go wrong.** A `402` from the mint is a plan limit, not an auth problem.
A `403` means the key is missing a scope, and the message names which. A `404`
means the world is not published or was deleted. Serving the studio with
`Cross-Origin-Embedder-Policy: require-corp` blocks the runtime iframe entirely.

---

# LLM providers

Anything that answers an OpenAI-shaped `POST {baseUrl}/chat/completions` works. The
studio sends `messages`, `model`, `temperature`, `max_tokens`, and, when a feature
needs structured output, a JSON response-format request. It reads
`choices[0].message.content` back. There is no vendor SDK in this repository.

**Nothing is active until you choose it.** The AI create and AI edit features stay
disabled, with a line pointing at Settings, until you select a provider. The
dropdown starts on "none" and nothing is called until you pick a preset. Ollama
is the one that needs no key, but a
preselection is not a connection. Making `localhost:11434` live by default would
show a connection error on first launch to everyone who is not already running
Ollama, which reads as a broken app rather than an unconfigured one.

Each preset stores three fields: base URL, API key, and model. Every field is
editable, so a preset is a starting point rather than a constraint. The adapter
appends `/chat/completions` and `/models` itself, and it tolerates a base URL
pasted with a trailing slash or with `/chat/completions` already on the end.

Model names move faster than this file will. Where the endpoint serves
`GET {baseUrl}/models`, the studio populates the dropdown from it, and that list is
the live truth. The ids below were read off each vendor's own documentation on
2026-07-30. Nothing is a whitelist. Type an id that appears in no list and it
round-trips fine, which is what people running fine-tunes and local quantisations
need.

**The degrade ladder.** Servers disagree about which optional fields they accept,
and the disagreement changes faster than any per-vendor table would stay correct.
So the adapter sends the portable spelling first and repairs only when the server
names the field in a 400 or 422:

- `response_format` is dropped, and a system message asking for a single JSON
  object takes its place. The contract says a provider that cannot enforce JSON
  must still try.
- `max_tokens` is renamed to `max_completion_tokens`. The GPT-5 family wants the
  second spelling, while Ollama, vLLM and Groq only know the first.
- `temperature` is dropped, for reasoning models that accept the default and
  nothing else.

A request that works pays nothing for this. If you are writing your own gateway,
matching that behaviour is optional, but naming the offending field in your error
body is what lets the ladder work at all.

**Anthropic has no preset on purpose.** Its OpenAI-compatible endpoint rejects
browser calls unless an extra opt-in header is sent, so a preset would look
supported and fail on the first request. Reach Claude models through OpenRouter
instead.

## Browser reachability, measured 2026-07-30

The studio calls these endpoints from a page, so an endpoint that does not return
CORS headers is unreachable no matter how valid the key is. Results of an
`OPTIONS` preflight from `Origin: http://localhost:4321`:

| Endpoint | Result |
|---|---|
| `api.cerebras.ai` | 200, `access-control-allow-origin: *` |
| `api.groq.com` | 204, `access-control-allow-origin: *` |
| `api.openai.com` | 200, echoes the requesting origin |
| `openrouter.ai` | 204, `access-control-allow-origin: *` |
| `api.reactor.inc` | 204, `access-control-allow-origin: *`, `Reactor-Api-Key` allowed |
| Ollama on `localhost:11434` | blocked unless you set `OLLAMA_ORIGINS` |
| LM Studio on `localhost:1234` | blocked unless you enable CORS |

Vendor CORS policy is a decision they can reverse. If a hosted vendor above starts
failing with a network error and no status code, re-run the preflight before
assuming the studio broke.

## Cerebras

Fast hosted inference for open-weight models. Free trial tier on signup.

- Keys: <https://cloud.cerebras.ai>, then **API Keys** in the left navigation.
- Base URL: `https://api.cerebras.ai/v1`
- Model: `gpt-oss-120b`

## Groq

Fast hosted inference for open-weight models. Free developer tier with rate
limits.

- Keys: <https://console.groq.com/keys>. They look like `gsk_…`.
- Base URL: `https://api.groq.com/openai/v1`
- Model: `llama-3.3-70b-versatile`. The current list is at
  <https://console.groq.com/docs/models>.

Groq is mostly OpenAI-compatible with a few gaps that do not affect this studio.
It ignores `logprobs`, `logit_bias` and `top_logprobs`, requires `n` to be 1, and
silently converts a temperature of exactly 0 to a very small number.

## OpenAI

- Keys: <https://platform.openai.com/api-keys>. They look like `sk-…`.
- Base URL: `https://api.openai.com/v1`
- Model: any chat model id. The preset starts on the cost-optimised tier.

## OpenRouter

One key, many vendors' models behind it. Useful for trying a model before opening
an account with whoever made it, and the only supported route to Claude models.

- Keys: <https://openrouter.ai/keys>. They look like `sk-or-…`.
- Base URL: `https://openrouter.ai/api/v1`
- Model ids carry a vendor prefix, such as `openai/…`, `anthropic/…`, `qwen/…`.
  `openrouter/auto` picks one for you.

## Ollama

Local, free, no key, no account. Runs on your machine, and the shortest path from
a fresh clone to AI authoring without paying anyone.

```sh
# install from https://ollama.com/download
ollama pull llama3.2
```

- Base URL: `http://localhost:11434/v1`
- API key: leave blank
- Model: whatever you have pulled

**CORS.** Ollama refuses browser origins it was not told about, and the refusal
looks like a dead network rather than a rejection. The variable is read at
startup, so set it and restart Ollama.

```sh
OLLAMA_ORIGINS=http://localhost:4321 ollama serve
```

On macOS, where Ollama runs as a background agent rather than in your shell, set it
for the login session and restart the app.

```sh
launchctl setenv OLLAMA_ORIGINS "http://localhost:4321"
```

On Linux with systemd, `systemctl edit ollama.service`, add
`Environment="OLLAMA_ORIGINS=http://localhost:4321"` under `[Service]`, then
`systemctl daemon-reload && systemctl restart ollama`.

## LM Studio

Local, free, no key. Graphical model management.

1. Install from <https://lmstudio.ai> and download a model.
2. Open the **Developer** tab and start the local server.
3. Turn on **Enable CORS** in the server settings. Without it the browser request
   fails before LM Studio ever logs it. From the CLI that is
   `lms server start --cors`, which is off when the flag is absent.

- Base URL: `http://localhost:1234/v1`
- API key: leave blank
- Model: whatever is loaded, as shown in the server tab

Enabling CORS lets any page you visit reach your local server. That is fine on a
machine you control and worth thinking about on one you share.

## vLLM, llama.cpp, and anything else OpenAI-shaped

Use the custom preset. Fill in the base URL, a key if the server requires one, and
the model name. TGI, LiteLLM, DeepSeek and most company gateways speak the same
shape.

- vLLM defaults to `http://localhost:8000/v1`. CORS is controlled by
  `--allowed-origins`, which takes a JSON list.
- llama.cpp's `llama-server` defaults to `http://localhost:8080/v1`.

The custom preset does not require a key, because a self-hosted server usually
accepts anything while a company gateway usually demands something. The endpoint's
own `401` is the honest gate.

---

# Capability reference

The probe runs when you save Settings and again before a session starts. It never
throws. A failure returns all-false capabilities with a `note` explaining why, and
Settings prints that note.

| Field | Meaning | False means |
|---|---|---|
| `streaming` | Produces frames at all | The provider is inert, or its transport is unavailable. |
| `promptableEvents` | Accepts authored world events mid-session | Your state machine cannot reach the picture. |
| `heldCommands` | Accepts held movement and look input | No WASD-style driving. |
| `persistentWorlds` | Can create a world later sessions re-enter by id | Every session starts fresh. |

## What breaks without promptableEvents

This is the one that silently wastes an afternoon.

Authored world events are how a state machine becomes visible. When the player
crosses a trigger, the studio pushes the new state's prompt into the live session,
and the renderer changes what it draws. A backend without that channel accepts the
frame stream and nothing else.

With `promptableEvents: false`:

- Transitions still fire. The graph runs exactly as authored.
- The HUD, the current-state readout, and the event log all update.
- Endings still trigger and the session still terminates on a terminal event.
- The picture ignores every one of those. It keeps rendering whatever it started
  with. A door you open or an alarm you trigger never appears on screen.

Nothing errors, so there is nothing to debug. The studio shows a standing warning
in the play view for exactly this reason. If you see it, either point at a backend
that accepts events or accept that you are testing graph logic rather than looks.

---

# Troubleshooting

**A request works in `curl` and fails in the studio.** CORS. The browser sends a
preflight your terminal does not, and a rejection arrives with no body to read.
Check the browser console. For local model servers, see the CORS notes above.

**A `ws://` connection fails from a deployed studio.** A page served over `https://`
cannot open an unencrypted socket. Use `wss://`, or serve the studio over
`http://`.

**A 404 with no mention of a model.** The base URL is not pointing at an
OpenAI-compatible root. Most such servers want it to end in `/v1`. A trailing
`/chat/completions` is harmless, since the adapter strips it.

**Reactor says it is not streaming.** That is usually the missing WebRTC SDK, not
the key. Read the probe note, then see the three routes under the Reactor section.

**The picture never changes.** Look at the capability row. If `promptableEvents`
is false, that is the answer.

**A model id 404s and the error names the model.** Vendors retire ids. Open the
model dropdown so the studio reloads the list from `GET {baseUrl}/models` and pick
from what is actually there. On a local server, pull or load the model first.

**An empty reply.** If the finish reason was `length`, the model spent its whole
budget before writing anything. Raise max tokens, or pick a model that does not
spend the budget on reasoning.

**A key needs to go away.** Clear the field in Settings and save. To remove
everything, delete the `alakazam-studio:` entries from `localStorage` in devtools.
Rotate the key at the provider if it was ever on a machine you do not control.
