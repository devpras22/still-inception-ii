# STILL — deploy the demo

A judge opens one link, presses **▶ begin**, and plays. No settings, no keys
in the browser. This is how that link is built.

## What runs where

| Piece | Where | Key it needs |
| --- | --- | --- |
| The studio app (Vite build) | Vercel static `dist/` | none |
| The STILL world record | static `public/still-world.json`, served by `/api/v1/worlds/...` | none |
| Seed photographs | static `public/seeds/*.png` | none |
| Ellen's voice (fish.audio) | `/api/voice` serverless | `FISH_AUDIO_API_KEY` |
| Improvised homecoming lines | `/api/llm/chat/completions` → OpenAI | `OPENAI_API_KEY` |
| World models (Reactor, WebRTC) | browser → api.reactor.inc directly | `REACTOR_API_KEY` (served at runtime by `/api/config`) |

Set those three in **Vercel → Project → Settings → Environment Variables**
(Production; no `VITE_` prefix — they are server-side only), then redeploy.

The player link is `/?play=w_mt5nh92neea951dd` — same world id as authored.

## Deploy steps

1. Push this repo to GitHub.
2. Vercel → Add New Project → import the repo, with **Root Directory set to
   `app/`** (the `vercel.json` there carries framework, build and output
   settings).
3. Add the three environment variables above, Deploy.
4. Open `https://<project>.vercel.app/?play=w_mt5nh92neea951dd` in a clean
   browser profile and press ▶ begin. The first Reactor session takes a few
   seconds; every photograph after that reseeds a fresh session.

## How the boot works (deployed only)

On load, before the app mounts, `src/studio/deploy-bootstrap.ts` fetches
`/api/config`. On a Vercel deployment with `REACTOR_API_KEY` set, that
returns the key, and the bootstrap writes the provider configuration into
this browser's localStorage: Reactor for world models, this origin's `/api`
as the hosted world store (which also routes the voice bridge), and `/api/llm`
as the OpenAI-compatible LLM endpoint. In a local dev clone `/api/config`
does not exist, the fetch fails, and the studio boots exactly as before —
your own Settings stay the source of truth.

## Rebuilding the world record after edits

The shipped world is a snapshot. After changing the world in the authoring
store (see `still/scripts/`), re-run the slimming step and commit the result:

```sh
cd still && npx tsx scripts/slim-world.ts
```

It extracts every embedded seed to `public/seeds/` (content-hashed, so
re-runs are idempotent) and rewrites `public/still-world.json` (~13 KB).

## Rotate the keys after the hackathon

The Reactor key is fetched by every visitor's browser (that is how a
browser-side world model works); treat all three keys as public once the
link is shared, and rotate them when the demo is done.
