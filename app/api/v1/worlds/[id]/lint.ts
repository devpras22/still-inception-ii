/** POST /api/v1/worlds/:id/lint — same precomputed verdict as validate. */
import type { DemoRequest, DemoResponse } from '../../../types'

export default function lint(_req: DemoRequest, res: DemoResponse): void {
  res.status(200).json({ ok: true, diagnostics: [] })
}
