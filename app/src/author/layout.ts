/**
 * Where an author dragged the cards.
 *
 * Kept BESIDE the world and never in it: `{ world, positions }` is persisted
 * under a per-world draft key, never into the graph. The reason is worth
 * stating: where a card
 * sits on your screen is not a fact about the world. Writing it into the
 * document would put a cosmetic change into the same revision stream as an
 * authored one, make every drag a graph write the doctrine has to re-run over,
 * and give two people editing the same world a conflict about nothing.
 *
 * So this is browser-local, per world, and disposable. Losing it costs a
 * layout, which the automatic one replaces.
 */
const KEY = 'alakazam-studio:layout:v1'

export interface XY {
  x: number
  y: number
}

type Store = Record<string, Record<string, XY>>

function readAll(): Store {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return isStore(parsed) ? parsed : {}
  } catch {
    // A corrupt or unreadable layout is not worth an error: the automatic
    // layout is a complete answer on its own.
    return {}
  }
}

function isStore(v: unknown): v is Store {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  for (const world of Object.values(v)) {
    if (typeof world !== 'object' || world === null || Array.isArray(world)) return false
    for (const at of Object.values(world)) {
      if (typeof at !== 'object' || at === null) return false
      const { x, y } = at as { x?: unknown; y?: unknown }
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return false
    }
  }
  return true
}

export function readLayout(worldId: string): Record<string, XY> {
  return readAll()[worldId] ?? {}
}

export function saveNodePosition(worldId: string, stateId: string, at: XY): Record<string, XY> {
  const all = readAll()
  const world = { ...(all[worldId] ?? {}), [stateId]: { x: Math.round(at.x), y: Math.round(at.y) } }
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...all, [worldId]: world }))
  } catch {
    // Out of quota: the positions are the first thing that should be given up,
    // never the world. The caller still gets the new map for this session.
  }
  return world
}

/** Forget every dragged position for a world, so the automatic layout returns. */
export function clearLayout(worldId: string): void {
  const all = readAll()
  if (!(worldId in all)) return
  const next = { ...all }
  delete next[worldId]
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* see above */
  }
}
