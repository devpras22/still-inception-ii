/**
 * Studio — the shell everything else is mounted into.
 *
 * The application root, the client/provider context every domain reads, the
 * hosted-endpoint configuration, the API call log, and the URL that names the
 * current view.
 *
 * Belongs here: app-wide wiring and navigation.
 * Belongs elsewhere: any feature. If a thing is about worlds, authoring, playing
 * or providers, it lives in that domain and the shell only composes it.
 *
 * View state lives in the URL (see ./url-state) rather than in local component
 * state, so every state worth looking at can be linked to and driven to
 * headlessly. The url-state vocabulary — readers, writers, the section list and
 * the defaults — is exported whole, so an external caller never re-derives it.
 */
export { App } from './App'
export { ClientProvider, useClient } from './ClientContext'
export { ApiLog } from './ApiLog'
export type { AppConfig } from './config'
export { readUrlState, writeUrlState, SECTIONS, DEFAULT_URL_STATE } from './url-state'
export type { Section, UrlState } from './url-state'
