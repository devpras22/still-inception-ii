#!/usr/bin/env node
// Serve a built studio (`dist/`) over HTTP, using nothing but Node's standard
// library.
//
// WHY this exists instead of `serve`, `http-server`, `express` or nginx: the
// studio ships three runtime dependencies and that number is a promise
// rather than an accident. Pulling a server package in would make the published
// container's dependency tree larger than the repository's, and swapping the
// runtime stage to nginx would mean maintaining a second, differently-shaped
// config for behaviour this file expresses in a hundred lines. `vite preview` is
// the other obvious candidate and it drags the whole build toolchain into the
// runtime image; Vite's own docs say it is not meant to serve production.
//
// Usage:  node scripts/serve.mjs [root]        (root defaults to ./dist)
// Env:    PORT (default 4321), HOST (default 0.0.0.0)

import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat, realpath } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'

const root = resolve(process.argv[2] || 'dist')
const port = Number(process.env.PORT || 4321)
const host = process.env.HOST || '0.0.0.0'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
}

/** The stat of `path` if it is a readable file, else null. Missing is normal
 *  here — every lookup below is a guess we are allowed to be wrong about. */
/** Lexical containment test. Necessary, and on its own not sufficient — see below. */
function withinRoot(target) {
  return target === root || target.startsWith(root + sep)
}

/**
 * Containment AFTER symlinks are resolved.
 *
 * The lexical check above compares the path as written, which a symlink walks
 * straight through: with `dist/passwd.txt -> /etc/passwd`, the request path is
 * inside the root, `resolve()` agrees, and the file served is /etc/passwd. A
 * stock `vite build` produces no symlinks, but this script is documented as
 * `node scripts/serve.mjs [root]` against any directory, so the guard has to
 * hold for directories it did not build.
 *
 * Missing files resolve to nothing and fall through to the normal 404.
 */
async function realWithinRoot(target) {
  try {
    return withinRoot(await realpath(target))
  } catch {
    return true
  }
}

async function statFile(path) {
  try {
    const s = await stat(path)
    return s.isFile() ? s : null
  } catch {
    return null
  }
}

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' })
  res.end(body)
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': TYPES['.txt'] })
    return res.end('method not allowed\n')
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  // A liveness answer that does not depend on the build having produced any
  // particular file. Docker's HEALTHCHECK asks here.
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': TYPES['.txt'], 'Cache-Control': 'no-store' })
    return res.end('ok\n')
  }

  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return send(res, 400, TYPES['.txt'], 'bad request\n')
  }

  // resolve() collapses `..` before we compare, so a crafted path cannot climb
  // out of the served directory however it was encoded.
  const target = resolve(join(root, pathname))
  if (!withinRoot(target)) {
    return send(res, 403, TYPES['.txt'], 'forbidden\n')
  }

  const ext = extname(target).toLowerCase()
  let path = null
  let file = await statFile(target)
  if (file) {
    path = target
  } else if (!ext) {
    // A directory, or a client-side route. Try its index, then the app shell.
    //
    // Requests that carry an extension deliberately fall through to 404 instead:
    // answering a missing `.js` with index.html is how a broken build turns into
    // ten minutes of staring at "Unexpected token '<'" in the browser console.
    for (const candidate of [join(target, 'index.html'), join(root, 'index.html')]) {
      file = await statFile(candidate)
      if (file) {
        path = candidate
        break
      }
    }
  }

  if (!path || !file) return send(res, 404, TYPES['.txt'], 'not found\n')

  // Now that a concrete file has been chosen, check it again with links
  // resolved. A symlink under the root points wherever it likes.
  if (!(await realWithinRoot(path))) {
    return send(res, 403, TYPES['.txt'], 'forbidden\n')
  }

  // Vite fingerprints everything it writes to /assets, so those may be cached
  // forever. The entry HTML must not be, or a redeploy leaves browsers asking
  // for bundle names that no longer exist.
  const cache = path.startsWith(join(root, 'assets') + sep)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache'

  res.writeHead(200, {
    'Content-Type': TYPES[extname(path).toLowerCase()] || 'application/octet-stream',
    'Content-Length': file.size,
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
    // Deliberately NOT Cross-Origin-Embedder-Policy: require-corp — it blocks the
    // play iframe and every cross-origin cover image. See README, "Self-hosting".
  })
  if (req.method === 'HEAD') return res.end()
  createReadStream(path).pipe(res)
})

server.listen(port, host, () => {
  process.stdout.write(`studio: serving ${root} on http://${host}:${port}\n`)
})

// As PID 1 in a container Node inherits no default signal disposition, so
// without these `docker compose down` waits out its ten-second grace period and
// then kills the process. Handling them makes shutdown immediate.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    // A client holding a keep-alive socket open must not delay the exit past the
    // orchestrator's patience.
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
