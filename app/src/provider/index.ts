/**
 * Provider — the seam that makes this studio yours.
 *
 * Four independent axes, chosen separately: which world model draws the
 * picture (your own Reactor key, your own WebSocket endpoint, the hosted
 * path, or an offline mock), which language model writes and edits worlds
 * (anything speaking the OpenAI chat-completions shape), which image model
 * paints a seed frame to anchor a new world (your own Gemini key, straight to
 * Google's generativelanguage API, or the hosted seed-frame path when an
 * Alakazam key is configured instead), and which vision model grounds a
 * world's clickable objects in what a detector can actually see (Moondream
 * Cloud with your own key, or a self-hosted Moondream Station with no key at
 * all).
 *
 * Belongs here: the provider contracts, the registry that constructs and
 * persists a choice, every adapter, the capability vocabulary, the Settings
 * screen that edits it (imported as `Settings` — the domain path already says
 * whose settings), the Reactor runtime registration the composition root
 * hands the SDK to, and the PURE geometry that turns a vision provider's raw
 * per-variant detections into which objects are safe to ground an anchor on
 * (`selectVerifiedObjects`) — it takes boxes in and hands verified objects
 * back, no provider, no fetch, no React.
 * Belongs elsewhere: anything that USES a provider — the player, the agent
 * that calls `selectVerifiedObjects` while authoring, Create's "paint a seed
 * frame" button, an author view that detects objects.
 *
 * The capability rule this domain enforces is load-bearing: a backend declares
 * what it can do and the studio believes only what was probed. A green chip over
 * a black rectangle is the exact failure this exists to prevent.
 */
export type {
  WorldCapabilities, WorldEvent, WorldSession, WorldConnectOptions,
  WorldModelProvider, LLMProvider, LLMRequest, LLMMessage, ImageProvider,
  VisionProvider, DetectedBox, ProviderConfig,
} from './types'
export { NO_CAPABILITIES, LLMError, WorldProviderError, VisionError } from './types'
export { selectVerifiedObjects } from './vision/probe'
export type { ProbeCandidate, VerifiedObject } from './vision/probe'
export {
  getWorldProvider, getLLMProvider, getImageProvider, getVisionProvider, capabilityWarning, worldProviders,
  loadProviderConfig, saveProviderConfig, defaultProviderConfig,
  WORLD_PROVIDER_IDS, LLM_PRESETS, CUSTOM_PRESET_ID,
} from './registry'
export { Settings } from './Settings'
export { CapabilityBadge } from './CapabilityBadge'
// The composition root (main.tsx) hands the Reactor SDK to this provider; the
// registration entry point is part of provider's public face, not an internal.
export { registerReactorRuntime } from './world/reactor'
export type { ReactorRuntimeFactory } from './world/reactor'
