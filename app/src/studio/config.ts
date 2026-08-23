// Studio configuration: API base, embed host, and the API key.
//
// Endpoints come from the environment; the KEY DOES NOT. Anything in a `VITE_`
// variable is inlined into the JavaScript bundle at build time and shipped to
// every browser that loads the page — so a secret key put there is published,
// not configured. The key is entered once in the Settings panel and kept in
// this browser's localStorage instead.
//
// That trade is deliberate: localStorage is readable by any script running on
// the page, which is an acceptable risk for a studio you run yourself and a bad
// one for a studio you expose to the internet. If you deploy this publicly, put
// your own backend in front and never hand the browser a secret key at all.
//
// This module once carried its own load/save/ready machinery too. The provider
// registry superseded it — the hosted API is one provider among several, and
// its settings are a slice of the provider config — so the dead copy was
// deleted rather than kept in case; git history is the archive. What remains is
// the shape the app assembles FROM the provider config.

export interface AppConfig {
  apiBase: string
  embedHost: string
  apiKey: string
}
