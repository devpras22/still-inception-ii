import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Standalone Creator Studio. Talks ONLY to the public Alakazam /v1 API
// (VITE_ALAKAZAM_API_BASE, default https://api.alakazam.gg). The live world player
// is loaded cross-origin as an <iframe> (the embed page carries its OWN COOP/COEP
// for the cross-origin isolation the runtime needs). This host must therefore NOT
// set COEP:require-corp — doing so would block cross-origin cover images (Supabase
// storage) and the embed iframe itself (ERR_BLOCKED_BY_RESPONSE ...ByCoep).
export default defineConfig({
  plugins: [react()],
  server: { port: 4321 },
  build: { target: 'es2020' },
})
