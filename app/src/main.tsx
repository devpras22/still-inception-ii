import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './studio'
import { registerReactorRuntime } from './provider'
import { bootstrapDeployedDemo } from './studio/deploy-bootstrap'
import './theme/styles.css'

// Teach the studio to draw Reactor frames.
//
// Reactor's video rides a WebRTC protocol only their SDK speaks, so the provider
// refuses to claim `streaming: true` until a runtime is handed to it — promising
// frames we cannot draw is the same silent lie the capability system exists to
// prevent. Registering it here means someone who pastes their own key gets video
// without a second install step.
//
// Delete this line and the studio still runs: the provider reports
// streaming:false with a note explaining why, instead of failing at play time.
// That is what keeps the SDK swappable — hand it a different runtime here and
// nothing else in the studio changes.
registerReactorRuntime(async (options) => {
  const { Reactor } = await import('@reactor-team/js-sdk')
  return new Reactor(options)
})

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root missing from index.html — the app has nowhere to mount')

// A deployed demo configures itself before the first render (see
// deploy-bootstrap.ts); a dev clone skips it in one failed fetch and mounts
// exactly as before.
void bootstrapDeployedDemo().catch(() => {}).then(() => {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
