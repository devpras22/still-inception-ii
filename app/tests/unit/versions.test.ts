/**
 * The Node version is stated in four places — `.nvmrc`, the Dockerfile ARG,
 * `package.json` engines, and the CI matrix. They drifted before (the README
 * still said node:20-alpine while everything else moved to 22), and a drift here
 * is the kind that passes every gate and then fails one platform at build time.
 *
 * A four-file equality is not a per-file convention-checker rule — it fits a
 * `node:test` assertion, and this suite already runs inside `npm run check` and
 * CI. So the agreement is pinned here: all four majors must match, and `.nvmrc`
 * (which nvm resolves literally) must satisfy the engines floor, because
 * `.nvmrc: 22` alone resolves to 22.0.0 and 22.0.0 does not satisfy `>=22.12.0`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

/** Split a semver-ish string into [major, minor, patch], missing parts = 0. */
function parts(v: string): [number, number, number] {
  const [a = '0', b = '0', c = '0'] = v.trim().replace(/^v/, '').split('.')
  return [Number(a), Number(b), Number(c)]
}
const gte = (a: [number, number, number], b: [number, number, number]) =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2]

test('the Node version agrees across .nvmrc, Dockerfile, engines, and CI', () => {
  const nvmrc = read('.nvmrc').trim()
  const dockerArg = read('Dockerfile').match(/^ARG NODE_VERSION=(\d+)/m)?.[1]
  const enginesFloor = String((JSON.parse(read('package.json')) as { engines?: { node?: string } }).engines?.node ?? '')
    .match(/(\d+\.\d+\.\d+)/)?.[1]
  const ciMatrix = read('.github/workflows/ci.yml').match(/node: \['(\d+)'\]/)?.[1]

  assert.ok(dockerArg, 'Dockerfile has no ARG NODE_VERSION=<major>')
  assert.ok(enginesFloor, 'package.json engines.node has no x.y.z floor')
  assert.ok(ciMatrix, "CI has no node: ['<major>'] matrix")

  const major = (v: string) => parts(v)[0]
  const majors = {
    nvmrc: major(nvmrc),
    docker: Number(dockerArg),
    engines: major(enginesFloor as string),
    ci: Number(ciMatrix),
  }
  const distinct = new Set(Object.values(majors))
  assert.equal(distinct.size, 1, `Node majors disagree: ${JSON.stringify(majors)}`)

  // .nvmrc must not resolve below the engines floor.
  assert.ok(
    gte(parts(nvmrc), parts(enginesFloor as string)),
    `.nvmrc ${nvmrc} is below the engines floor ${enginesFloor}`,
  )
})
