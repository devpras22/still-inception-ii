/**
 * The studio's view state, expressed in the URL.
 *
 * WHY THIS EXISTS. Every state that matters must be reachable by parameter
 * rather than only by clicking, because a state you cannot drive to headlessly
 * is a state you cannot verify — not once, and certainly not repeatedly. The
 * screenshot loop, the capture harness and the live-provider runs all need to
 * open the studio *already* in the state under test; before this they had to
 * click their way there, which made every visual check a multi-step script that
 * broke whenever a button moved.
 *
 * It is also the honest shape for a web app: a view worth looking at is a view
 * worth linking to. Section, open world, editor tab and selection, open player,
 * settings and theme are all addressable, and the URL is the single source of
 * truth for them.
 *
 *   ?section=creations|create|book|community|account|api
 *   ?world=<id>     open the graph editor on that world
 *   ?tab=<id>       which editor sub-panel is open (meaningful with ?world=)
 *   ?sel=<ref>      what is selected in the editor, as state:<id> / event:<name>
 *   ?play=<id>      open the player on that world
 *   ?campaign=<id>  …and play it as one act of that campaign
 *   ?state=<id>     …booting into that state instead of the entrance
 *   ?variant=<tag>  …with that state's alternate prompt (the A/B B side)
 *   ?settings=1     open the settings panel
 *   ?theme=dark|light  render in that theme (wins over the persisted choice —
 *                      which is what makes a screenshot run deterministic)
 *
 * `tab` and `sel` are carried as opaque strings on purpose: their vocabulary
 * belongs to the editor (author/), and the editor validates them — an unknown
 * tab falls back, a malformed selection is no selection. This module only
 * plumbs.
 *
 * Reading is total: an unknown section or theme falls back rather than
 * throwing, because a hand-edited URL must never be able to render a broken
 * studio.
 */

import { isThemeName, type ThemeName } from '../theme'

export const SECTIONS = ['creations', 'create', 'book', 'community', 'account', 'api'] as const
export type Section = (typeof SECTIONS)[number]

export interface UrlState {
  section: Section
  worldId: string | null
  /** Editor sub-panel id; opaque here, validated by the editor. */
  tab: string | null
  /** Editor selection as `state:<id>` / `event:<name>`; opaque here. */
  sel: string | null
  playId: string | null
  /** Play `playId` as one act of this campaign — the hand-off between acts is
   *  then live. Meaningless without `play`. */
  campaignId: string | null
  /** Boot the player straight INTO this state rather than the entrance — how an
   *  A/B arm is played, and how a long world is re-entered where you left it. */
  playState: string | null
  /** …with this state's alternate prompt swapped in. The seed is unchanged, so
   *  the only difference between the two arms is the words. */
  playVariant: string | null
  settings: boolean
  /** Explicit theme override. null = no parameter → the persisted choice rules. */
  theme: ThemeName | null
}

export const DEFAULT_URL_STATE: UrlState = {
  section: 'creations',
  worldId: null,
  tab: null,
  sel: null,
  playId: null,
  campaignId: null,
  playState: null,
  playVariant: null,
  settings: false,
  theme: null,
}

function isSection(value: string | null): value is Section {
  return value !== null && (SECTIONS as readonly string[]).includes(value)
}

/** Parse a search string. Never throws; unknown values fall back to defaults. */
export function readUrlState(search: string): UrlState {
  let params: URLSearchParams
  try {
    params = new URLSearchParams(search)
  } catch {
    return { ...DEFAULT_URL_STATE }
  }
  const section = params.get('section')
  const theme = params.get('theme')
  return {
    section: isSection(section) ? section : DEFAULT_URL_STATE.section,
    worldId: params.get('world'),
    tab: params.get('tab'),
    sel: params.get('sel'),
    playId: params.get('play'),
    campaignId: params.get('campaign'),
    playState: params.get('state'),
    playVariant: params.get('variant'),
    settings: params.get('settings') === '1',
    theme: isThemeName(theme) ? theme : null,
  }
}

/** Serialize state back to a search string. Defaults are omitted, so the common
 *  case is a bare URL rather than one carrying seven redundant parameters. */
export function writeUrlState(state: UrlState): string {
  const params = new URLSearchParams()
  if (state.section !== DEFAULT_URL_STATE.section) params.set('section', state.section)
  if (state.worldId) params.set('world', state.worldId)
  if (state.tab) params.set('tab', state.tab)
  if (state.sel) params.set('sel', state.sel)
  if (state.playId) params.set('play', state.playId)
  if (state.campaignId) params.set('campaign', state.campaignId)
  if (state.playState) params.set('state', state.playState)
  if (state.playVariant) params.set('variant', state.playVariant)
  if (state.settings) params.set('settings', '1')
  if (state.theme) params.set('theme', state.theme)
  const query = params.toString()
  return query ? `?${query}` : ''
}
