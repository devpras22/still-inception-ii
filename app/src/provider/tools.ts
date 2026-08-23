/**
 * Provider operations, as tools.
 *
 * Reading what the configured backends are and what they can actually do. The
 * capability probe is the interesting one: it is the difference between what a
 * backend claims in a config file and what it answers when asked.
 */

import { defineTool } from '../tool/define'
import { worldProviders } from './registry'

export const providerTools = defineTool({
  summary: 'World-model and language-model providers: what is available and what it can do.',
  description:
    'Providers are chosen in the studio and stored in the browser, so the terminal can describe them but does not configure them. Probing is the honest way to find out what a backend does: a declared capability is a claim, a probed one is an answer.',
  children: {
    list: defineTool({
      summary: 'List the world-model providers this build can use.',
      description:
        'The order is deliberate: the ones you own first, the hosted path next, and the one that needs nothing last. Mock is the default so the studio works before anyone has signed up for anything.',
      kind: 'query',
      params: {},
      async run() {
        return { providers: worldProviders.map((p) => ({ id: p.id, label: p.label, blurb: p.blurb })) }
      },
    }),
  },
})
