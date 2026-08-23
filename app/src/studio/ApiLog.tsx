import { useClient } from './ClientContext'
import { Button } from '../theme'

/**
 * The live action log — the studio's "one tool surface" proof, watchable.
 *
 * Every action in the app is a tool call dispatched in process, and those rows
 * appear here with their dotted path. When the store is hosted, the same action
 * also fans out into /v1 HTTP requests, which appear as their own rows — so one
 * click showing a tool row followed by its HTTP rows is the layering, live. On
 * the keyless path there are no HTTP rows and the tool rows still tell the
 * truth, where the old HTTP-only log sat permanently empty.
 */
export function ApiLog() {
  const { log, clearLog } = useClient()
  return (
    <div className="apilog">
      <div className="apilog-head">
        <span>Actions <span className="muted">({log.length})</span></span>
        <Button variant="ghost" onClick={clearLog} text="clear" />
      </div>
      <div className="apilog-body">
        {log.length === 0 && <div className="muted apilog-empty">every action is a tool call — it shows up here (hosted /v1 requests too)</div>}
        {log.slice().reverse().map((e) =>
          e.via === 'tool' ? (
            <div className="apilog-row" key={e.id} title={`origin: ${e.origin}`}>
              <span className="apilog-method">{e.kind === 'mutation' ? 'tool·mut' : 'tool·qry'}</span>
              <span className={'apilog-status ' + (e.ok ? 'ok' : 'err')}>{e.ok ? 'ok' : e.status || 'ERR'}</span>
              <span className="apilog-path" title={e.path}>{e.path}{e.origin === 'agent' ? ' ⌁agent' : ''}</span>
              <span className="apilog-ms muted">{e.ms}ms</span>
            </div>
          ) : (
            <div className="apilog-row" key={e.id}>
              <span className="apilog-method">{e.method}</span>
              <span className={'apilog-status ' + (e.status >= 400 || e.status === 0 ? 'err' : 'ok')}>{e.status || 'ERR'}</span>
              <span className="apilog-path" title={e.path}>{e.path}</span>
              <span className="apilog-ms muted">{e.ms}ms</span>
            </div>
          ),
        )}
      </div>
    </div>
  )
}
