/**
 * One world, rendered as a card.
 *
 * Worlds and Community each hand-rolled this markup, and the two copies had
 * already begun to disagree on alt text and layout — the standard fate of a
 * treatment that exists twice. The shell (cover with its fallback, meta strip,
 * action row) lives here once; what a view puts IN the meta and actions is its
 * own business, passed as slots.
 *
 * It lives in the world domain, not the theme: a component that takes a
 * `WorldListItem` is a world component, however generic it looks.
 */

import type { ReactNode } from 'react'
import type { WorldListItem } from './types'

export function WorldCard({ item, meta, actions }: { item: WorldListItem; meta: ReactNode; actions: ReactNode }) {
  return (
    <div className="world-card">
      {item.cover ? (
        <img className="cover" src={item.cover} alt={item.name || 'cover'} loading="lazy" crossOrigin="anonymous" />
      ) : (
        // A coverless world still gets a face: its own initial over the token
        // gradient, instead of a flat caption apologising for the absence.
        <div className="cover-fallback">
          <span className="cover-glyph">{(item.name || '?').trimStart().charAt(0).toUpperCase() || '?'}</span>
          <span className="cover-note">no cover yet</span>
        </div>
      )}
      <div className="meta">{meta}</div>
      <div className="actions">{actions}</div>
    </div>
  )
}
