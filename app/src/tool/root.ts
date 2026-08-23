/**
 * The tool tree.
 *
 * One explicit object literal, composed from each domain's own `tools.ts`. No
 * registry, no dynamic discovery, no plugin scan: the literal is greppable and
 * type-checked, and a tool that is not in it does not exist. That is a feature —
 * "what can this thing do" has a single answer you can read.
 */

import { defineTool } from './define'
import { worldTools } from '../world/tools'
import { authorTools } from '../author/tools'
import { providerTools } from '../provider/tools'
import { docsTool } from './docs'

export const root = defineTool({
  summary: 'Author and inspect worlds for world models, from the terminal.',
  description:
    'The same operations the studio performs, driven headlessly. Worlds live in a JSON file under ~/.alakazam-studio (override with STUDIO_HOME), which is the same store the browser app uses through a different driver — so a world authored here is a world the studio can open.',
  children: {
    world: worldTools,
    author: authorTools,
    provider: providerTools,
    docs: docsTool,
  },
})
