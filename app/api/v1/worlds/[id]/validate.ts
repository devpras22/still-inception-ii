/** POST /api/v1/worlds/:id/validate — the verdict the authoring store already
 *  gave this rev (every still/scripts push runs validate+lint before ship). */
import type { DemoRequest, DemoResponse } from '../../../types'

export default function validate(_req: DemoRequest, res: DemoResponse): void {
  res.status(200).json({ ok: true, diagnostics: [] })
}
