#!/usr/bin/env node
/**
 * Convention checker: the taste-free half of the doctrine, as executable rules.
 *
 * A written rule is only as good as every future reader's memory of it, and the
 * primary readers here are LLM agents starting from a cold context. So anything
 * mechanical becomes a check that fails, not a paragraph someone might read.
 *
 * DESIGN NOTES, because the shape is deliberate:
 *
 *  · Zero dependencies. This repo ships three runtime dependencies and a
 *    hand-rolled file server; a linter that needs its own toolchain would be the
 *    largest thing in the tree. These rules are regex-and-line based on purpose:
 *    each is cheap enough to run on every edit, and the ones that genuinely need
 *    an AST are left to `tsc`, which already has one.
 *  · The rule registry generates its own --help, so the documentation cannot
 *    drift from the enforcement. That drift is the whole reason prose loses.
 *  · Severities mean what they say. `error` fails the run. There is no
 *    "zero tolerance" rule quietly registered as a warning.
 *  · Grandfathered counts only ever shrink, AND they are exact: a file measured
 *    BELOW its budget fails ("lower it"), so headroom can never hide a new
 *    violation. Adding an entry to silence a new violation defeats the point.
 *  · A rule may expose `checkAll(files, read)` for facts that span files — a
 *    MISSING public face, a hex outside the stylesheet's :root. `--help` is still
 *    generated from the one registry, so it cannot drift.
 *
 * Usage:
 *   node scripts/check-conventions.mjs [path…]     (default: src, tests, scripts)
 *   node scripts/check-conventions.mjs --help       (or `npm run check:conventions -- --help`)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, relative, extname, sep } from 'node:path'

const ROOT = process.cwd()
const DEFAULT_ROOTS = ['src', 'tests', 'scripts', 'examples', 'bin']

/** The concept directories under src/. A caller imports another one's face,
 *  never a file inside it. `tool` is deliberately absent: it is the framework
 *  primitive a domain's tools.ts declares leaves with (imported like a library),
 *  and its own `root.ts` is the composition root of the tree — policing its
 *  internal imports would fight the assembly-file reality. It is still REQUIRED
 *  to carry a public face (see require-public-face). */
const DOMAINS = ['account', 'author', 'play', 'provider', 'studio', 'theme', 'world']

/**
 * Files whose CURRENT violations are grandfathered, with the count they had when
 * the rule landed. The gate binds new code from day one; the backlog burns down
 * on its own schedule. Exact both ways: a count may only go DOWN, and a file
 * measured below its number fails so the headroom cannot hide a new violation.
 * NEVER add an entry to silence a new violation: the violation is the point.
 */
const GRANDFATHERED = new Map([
  // no-unsafe-assertions: burned down from the 64 this map once grandfathered.
  // The hosted-response boundary narrows every /v1 payload, the local store's
  // op functions validate the untrusted JSON they apply, and everything else is
  // instanceof/predicate narrowing. ONE survivor, by design:
  ['no-unsafe-assertions', new Map([
    // globalThis.__REACTOR_SDK__ — the plain-<script>-tag escape hatch. An
    // untyped global cannot be verified past `typeof === 'function'`; the cast
    // and its reasoning live together at the site.
    ['src/provider/world/reactor.ts', 1],
  ])],
  // theme-vocabulary: the 56 grandfathered raw buttons are gone and the rule
  // now polices EVERY raw interactive element. Two survivors, each for a
  // stated mechanical reason, each commented at its site:
  ['theme-vocabulary', new Map([
    // A hidden type=file input driven by ref from the Upload button — TextInput
    // is a plain function component (no forwardRef), so wrapping would break it.
    ['src/author/Vision.tsx', 1],
    // The provider radio cards: the vocabulary has no Radio yet. When it grows
    // one, this budget goes with it.
    ['src/provider/Settings.tsx', 1],
  ])],
  ['no-hex-outside-theme', new Map([
    // The one budget that stays: the mock's canvas palette fakes a VIDEO FEED —
    // content, not chrome. A stub that recoloured itself on theme flip would
    // misrepresent the real feed it stands in for. Everything else is tokens.
    ['src/provider/world/mock.ts', 10],
  ])],
  ['domain-public-face', new Map([
    // Value import of AlakazamClient; flipping to the '../../world' face plausibly
    // creates a runtime cycle (provider→registry→alakazam→world→…→provider), so
    // it is flipped in an isolated commit the boot e2e can adjudicate, not here.
    ['src/provider/world/alakazam.ts', 1],
  ])],
  // no-node-in-browser: no budget. `world.import` once dynamically imported
  // `node:fs`; the tool tree now reads files through an injected `ctx.readTextFile`
  // the CLI supplies, so no source under src/ names a node module and the tree is
  // statically safe to bundle (npm run build is the proof).
])

/** This file quotes rule text that would trip its own rules. */
const SELF = 'scripts/check-conventions.mjs'
const CODE = new Set(['.ts', '.tsx', '.mjs', '.js'])

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve a relative import specifier against a posix file path → target path. */
function resolveImport(filePath, spec) {
  const parts = filePath.split('/').slice(0, -1)
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

/** True when `target` reaches past another domain's public face. */
function reachesPastFace(target, mine) {
  const segs = target.split('/')
  if (segs[0] !== 'src' || !DOMAINS.includes(segs[1]) || segs[1] === mine) return false
  if (segs.length <= 2) return false // bare `src/<domain>` — the face itself
  if (segs[2] === 'index') return false // explicit `src/<domain>/index`
  if (/\.(css|svg|png|json)$/.test(segs[segs.length - 1])) return false // a static asset, not code
  return true
}

// ── Rules ────────────────────────────────────────────────────────────────────

/** @type {{name:string, severity:'error'|'warning', description:string, check?:(f:{path:string,text:string,lines:string[]})=>any[], checkAll?:(files:{path:string,text:string}[])=>any[]}[]} */
const rules = [
  {
    name: 'no-unsafe-assertions',
    severity: 'error',
    description:
      '`as T` (except `as const`) and non-null `!` are forbidden. They are the two places "the types say this is safe" is an unverified claim. Use a type guard, narrow properly, or fix the source type.',
    check: ({ lines, path }) => {
      if (path.startsWith('tests/')) return []
      const found = []
      lines.forEach((raw, i) => {
        if (raw.trimStart().startsWith('//') || raw.trimStart().startsWith('*')) return
        // Blank the CONTENTS of quoted strings before matching: prose like a
        // describe "…the bundle as JSON…" is not an assertion, and a rule that
        // read the word "as" out of English would fire on every doc string. Only
        // '' and "" are blanked, never `` ` `` — an assertion inside a template
        // expression (`${x as Foo}`) is real code and must still be counted.
        const line = raw
          .replace(/'(?:[^'\\]|\\.)*'/g, "''")
          .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        const as = line.match(/\bas\s+(?!const\b)[A-Z][A-Za-z0-9_<>\[\]]*/)
        if (as && !/eslint-disable|@ts-expect-error/.test(line)) {
          found.push({ line: i + 1, message: `unsafe assertion \`${as[0]}\``, suggestion: 'narrow with a type guard, or fix the source type' })
        }
        // Non-null `!`: an identifier/`)`/`]` followed by `!` then a member/close/
        // end — not `!=`/`!==` (excluded because `=` cannot follow), and not a `!`
        // inside a string ending in `!` (excluded because `"` cannot follow).
        if (/[\w$)\]]!(?=[.)\];,\s]|$)/.test(line) && !/eslint-disable|@ts-expect-error/.test(line)) {
          found.push({ line: i + 1, message: 'non-null assertion `!`', suggestion: 'add a null check or narrow the type' })
        }
      })
      return found
    },
  },
  {
    name: 'no-secret-in-env-var',
    severity: 'error',
    description:
      'No VITE_ variable may carry a key or secret. Vite inlines every VITE_ value into the JavaScript bundle at build time, so a key placed there is published to every visitor rather than configured by one operator.',
    check: ({ lines }) => {
      const found = []
      lines.forEach((line, i) => {
        const m = line.match(/VITE_[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*/)
        if (m) found.push({ line: i + 1, message: `${m[0]} would be compiled into the client bundle`, suggestion: 'read it from Settings and keep it in localStorage instead' })
      })
      return found
    },
  },
  {
    name: 'no-html-strings',
    severity: 'error',
    description:
      'HTML is the output of rendering a component, never authored as a string. A hand-built document drifts from the component that renders the same thing everywhere else.',
    check: ({ text, lines }) => {
      const token = '<!doctype' + ' html'
      if (!text.toLowerCase().includes(token)) return []
      const found = []
      lines.forEach((line, i) => {
        if (line.toLowerCase().includes(token)) found.push({ line: i + 1, message: 'string-built HTML document', suggestion: 'render a component instead' })
      })
      return found
    },
  },
  {
    name: 'no-encoded-judgment',
    severity: 'error',
    description:
      'Taste, meaning and editorial decisions come from a language model, never from a keyword list or a threshold ladder in code. Code handles structure, I/O and deterministic transforms.',
    check: ({ lines, path }) => {
      if (!path.startsWith('src/')) return []
      const found = []
      lines.forEach((line, i) => {
        if (/\b(sentiment|categorize|classify|score)\w*\s*\(/i.test(line) && /includes\(|match\(|test\(/.test(line)) {
          found.push({ line: i + 1, message: 'keyword matching standing in for judgment', suggestion: 'make it an input or a model call' })
        }
      })
      return found
    },
  },
  {
    name: 'no-todo-without-owner',
    severity: 'warning',
    description:
      'A TODO with no stated blocker is a note to nobody. State what would unblock it, or delete it — git history is the archive.',
    check: ({ lines }) => {
      const found = []
      lines.forEach((line, i) => {
        if (/\bTODO\b/.test(line) && !/TODO\([^)]+\)/.test(line)) {
          found.push({ line: i + 1, message: 'bare TODO', suggestion: 'TODO(what-would-unblock-it): …, or remove it' })
        }
      })
      return found
    },
  },
  {
    name: 'no-file-url-pathname',
    severity: 'error',
    description:
      'A file URL is turned into a path with fileURLToPath(), never with .pathname. On Windows a file URL\'s pathname is "/C:/Users/..." — with a leading slash — so the result is a path that does not exist, and every join() and spawn() built on it fails there and nowhere else. That bug shipped twice here: once in the convention checker itself, and once in a test, where it left CI red on windows-latest for ten consecutive pushes while the macOS gate stayed green.',
    check: ({ lines, path }) => {
      if (path.endsWith('check-conventions.mjs')) return []
      const found = []
      lines.forEach((line, i) => {
        // `new URL(..., import.meta.url).pathname`, however it is spelled.
        if (/import\.meta\.url[\s\S]*?\)\s*\.pathname/.test(line) || /\.pathname\b/.test(line) && /import\.meta\.url/.test(line)) {
          found.push({ line: i + 1, message: 'file URL read via .pathname', suggestion: 'fileURLToPath(new URL(…, import.meta.url))' })
        }
      })
      return found
    },
  },
  {
    name: 'no-raw-nul',
    severity: 'error',
    description:
      'No raw NUL (0x00) byte in a source file. grep/ripgrep classify such a file as binary and silently skip it in every sweep — including the CI secret scan — so a NUL hides whatever else is on the line. Write the separator as the `\\u0000` escape (identical string, visible to tooling).',
    check: ({ text, lines }) => {
      if (!text.includes('\u0000')) return []
      const found = []
      lines.forEach((line, i) => {
        if (line.includes('\u0000')) found.push({ line: i + 1, message: 'raw NUL byte', suggestion: "write it as '\\u0000'" })
      })
      return found
    },
  },
  {
    name: 'domain-public-face',
    severity: 'error',
    description:
      "A caller imports another domain's public face (`../world`), never a file inside it (`../world/store/local`). Reaching past the index couples you to an arrangement the owning domain is free to change, and it is how a concept quietly acquires two owners. The browser composition root (main.tsx) is held to the same rule. The NODE composition root (bin/studio.ts) is the one sanctioned deep-reacher: it must construct the file-backed store, and the node-only modules it wires (store/file.node) cannot be exported through the world face without dragging node:fs into the browser bundle. Tests are outside this rule by design — they exercise internals.",
    check: ({ path, lines }) => {
      const mine = path.startsWith('src/') ? path.split('/')[1] : null
      const isComposition = path === 'src/main.tsx'
      if ((!mine || !DOMAINS.includes(mine)) && !isComposition) return []
      const found = []
      lines.forEach((line, i) => {
        const m = line.match(/(?:from|import)\s+['"]((?:\.\.?\/)[^'"]+)['"]/)
        if (!m) return
        const target = resolveImport(path, m[1])
        if (reachesPastFace(target, mine)) {
          const dom = target.split('/')[1]
          found.push({ line: i + 1, message: `reaches into ${dom}/ internals (${m[1]})`, suggestion: `import from '../${dom}' and export it there if it is missing` })
        }
      })
      return found
    },
  },
  {
    name: 'lives-in-a-domain',
    severity: 'error',
    description:
      'Every source file under src/ belongs to a DOMAIN — src/<domain>/… — never to src/ itself. A file with no domain is a concept with no owner, and the next person to need that behaviour writes a second copy of it somewhere else. The only exception is the composition root (main.tsx), which by definition belongs to no domain because its job is to assemble all of them.',
    check: ({ path }) => {
      if (!path.startsWith('src/')) return []
      const rest = path.slice('src/'.length)
      // A file sitting directly in src/ has no owning domain.
      if (!rest.includes('/')) {
        if (rest === 'main.tsx' || rest === 'vite-env.d.ts') return []
        return [{
          line: 1,
          message: `${rest} sits in src/ with no owning domain`,
          suggestion: `move it into the domain that owns this concept (${DOMAINS.join(', ')}, theme, tool) — or say which new domain it starts`,
        }]
      }
      const domain = rest.slice(0, rest.indexOf('/'))
      const known = [...DOMAINS, 'theme', 'tool']
      if (known.includes(domain)) return []
      return [{
        line: 1,
        message: `src/${domain}/ is not a domain this studio knows about`,
        suggestion: `either this belongs inside an existing domain (${known.join(', ')}), or it is a NEW domain and needs its own public face and an entry in this checker's DOMAINS`,
      }]
    },
  },
  {
    name: 'require-public-face',
    severity: 'error',
    description:
      'Every first-level directory under src/ has an index.ts(x) whose doc comment states what it owns and what belongs elsewhere. "Where does X live?" must have exactly one answer, written where someone will find it — and a MISSING face is caught, not just a bad one.',
    check: ({ path, text }) => {
      if (!/^src\/[a-z]+\/index\.tsx?$/.test(path)) return []
      return /\/\*\*[\s\S]*Belongs here:[\s\S]*Belongs elsewhere:/.test(text)
        ? []
        : [{ line: 1, message: 'public face lacks an ownership doc comment', suggestion: 'state what belongs here and what belongs elsewhere' }]
    },
    checkAll: (files) => {
      const dirs = new Set()
      for (const f of files) {
        const m = f.path.match(/^src\/([a-z]+)\//)
        if (m) dirs.add(m[1])
      }
      const found = []
      for (const dir of dirs) {
        const hasFace = files.some((f) => f.path === `src/${dir}/index.ts` || f.path === `src/${dir}/index.tsx`)
        if (!hasFace) found.push({ path: `src/${dir}/`, line: 1, message: `domain has no public face (index.ts)`, suggestion: 'add src/' + dir + '/index.ts with an ownership doc comment' })
      }
      return found
    },
  },
  {
    name: 'no-node-in-browser',
    severity: 'error',
    description:
      "Browser code must not import a Node builtin, static or dynamic. One tsconfig serves both runtimes so `node:fs` resolves everywhere, and an accidental import fails at runtime in the browser (or drags Node into the bundle). Node-only modules are named *.node.ts and are the only files allowed to reach for them.",
    check: ({ path, lines }) => {
      if (!path.startsWith('src/') || path.endsWith('.node.ts')) return []
      const found = []
      lines.forEach((line, i) => {
        const m = line.match(/from '(node:[a-z_/]+)'/) || line.match(/import\('(node:[a-z_/]+)'\)/)
        if (m) found.push({ line: i + 1, message: `browser module imports ${m[1]}`, suggestion: 'move it to a *.node.ts module, or inject it through ctx' })
      })
      return found
    },
  },
  {
    name: 'theme-vocabulary',
    severity: 'error',
    description:
      'Interactive elements come from the theme — Button, TextInput, TextArea, Select, Checkbox — never from a raw element. One vocabulary, defined once: a hand-rolled control misses the busy state, the disabled handling, the id-linked hint, the default type. The scan is whole-tag, so an attribute on the next line does not smuggle a control past the rule.',
    check: ({ path, text }) => {
      if (!path.startsWith('src/') || path.startsWith('src/theme')) return []
      const found = []
      // Whole opening tag, possibly spanning lines. EVERY raw interactive
      // element counts now, not only the btn-classed ones the first version of
      // this rule policed — the vocabulary exists, so a bespoke control is a
      // second vocabulary starting.
      // COMMENT LINES ARE NOT CODE. The scan is whole-text (a tag may span
      // lines), so prose ABOUT a control read as a control: a comment
      // explaining why a <select>'s value has to be narrowed rather than
      // asserted was reported as a raw select. A rule that fires on writing
      // about the thing teaches people to stop writing about the thing.
      //
      // Only WHOLE comment lines are blanked, and they are blanked to empty
      // strings so every later line number still matches the file. A code line
      // with a trailing comment keeps its code — stripping to end-of-line there
      // could hide a real violation behind a URL's `//`.
      const scannable = text
        .split('\n')
        .map((line) => {
          const t = line.trimStart()
          return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') ? '' : line
        })
        .join('\n')
      const re = /<(button|input|select|textarea)\b[^>]*?>/gs
      let m
      while ((m = re.exec(scannable)) !== null) {
        const line = scannable.slice(0, m.index).split('\n').length
        found.push({
          line,
          message: `raw <${m[1]}> in a domain view`,
          suggestion: 'compose Button/TextInput/TextArea/Select/Checkbox from ../theme',
        })
      }
      return found
    },
  },
  {
    name: 'no-dead-exports',
    severity: 'error',
    description:
      'An export nothing names is a capability that does not exist. This studio has shipped six of them — a variants field written by two ops and read by nothing, six campaign lints with no caller, a director branch dropped for want of a feature — and each looked complete from the inside. A re-export does NOT count as a consumer: an index that forwards a dead name is the plumbing that hides it. Tests, the CLI and scripts DO count, since a thing that exists to be tested is still consumed.',
    checkAll: (files) => {
      const found = []
      // Index files forward names; counting them as consumers is exactly how a
      // dead export stays invisible. Everything else counts.
      const consumers = files.filter((f) => !/\/index\.tsx?$/.test(f.path))
      for (const f of files) {
        if (!f.path.startsWith('src/')) continue
        const re = /export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/g
        let m
        while ((m = re.exec(f.text)) !== null) {
          const name = m[1]
          const rx = new RegExp(`\\b${name}\\b`)
          const named = consumers.some((o) => o.path !== f.path && rx.test(o.text))
          if (named) continue
          // Used inside its own file is not DEAD, it is over-exported — a
          // different (and much smaller) problem, so it is not reported here.
          const ownUses = (f.text.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length
          if (ownUses > 1) continue
          const line = f.text.slice(0, m.index).split('\n').length
          found.push({
            path: f.path,
            line,
            message: `nothing names \`${name}\``,
            suggestion: 'delete it, or wire the thing it was written for',
          })
        }
      }
      return found
    },
  },
  {
    name: 'no-hex-outside-theme',
    severity: 'error',
    description:
      'A colour literal (`#rgb`) lives only in the theme. A component that names a colour cannot follow the theme when it changes, which is how the light theme would leave islands of dark. The theme stylesheet holds every colour in :root; anything below :root is flagged too.',
    check: ({ path, lines }) => {
      if (!path.startsWith('src/') || path.startsWith('src/theme/')) return []
      if (!/\.(ts|tsx)$/.test(path)) return []
      const found = []
      lines.forEach((line, i) => {
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return
        const m = line.match(/#[0-9a-fA-F]{3,8}\b/)
        if (m) found.push({ line: i + 1, message: `colour literal ${m[0]} in a component`, suggestion: 'use a var(--token) from ../theme' })
      })
      return found
    },
    checkAll: () => {
      // The stylesheet: every colour belongs inside the :root block.
      let css
      try {
        css = readFileSync(join(ROOT, 'src/theme/styles.css'), 'utf8')
      } catch {
        return []
      }
      const found = []
      let depth = 0
      let inRoot = false
      css.split('\n').forEach((line, i) => {
        const opensRoot = /:root\b[^{]*\{/.test(line)
        if (opensRoot) inRoot = true
        // crude brace tracking is enough: :root is a single top-level block here
        for (const ch of line) {
          if (ch === '{') depth++
          else if (ch === '}') { depth--; if (depth === 0) inRoot = false }
        }
        if (!inRoot && !line.trimStart().startsWith('/*') && !line.trimStart().startsWith('*') && /#[0-9a-fA-F]{3,8}\b/.test(line)) {
          const m = line.match(/#[0-9a-fA-F]{3,8}\b/)
          found.push({ path: 'src/theme/styles.css', line: i + 1, message: `colour literal ${m[0]} outside :root`, suggestion: 'add a token to :root and reference it' })
        }
      })
      return found
    },
  },
  {
    name: 'addressable-state',
    severity: 'error',
    description:
      'Every view state that matters is reachable by URL parameter. A state you can only reach by clicking is a state that cannot be verified repeatedly, headlessly, or by anyone else.',
    check: ({ path, text }) => {
      if (path !== 'src/studio/App.tsx') return []
      return text.includes('readUrlState') ? [] : [{ line: 1, message: 'App no longer reads view state from the URL', suggestion: 'see src/studio/url-state.ts' }]
    },
  },
  {
    name: 'public-face-doc-current',
    severity: 'warning',
    description:
      "A public face's export surface must not change while its ownership doc comment stays byte-identical. Diffs the working tree against the git index: if the `export` lines moved but the leading /** … */ block did not, the doc is drifting from what the domain now owns.",
    check: ({ path, text }) => {
      if (!/^src\/[a-z]+\/index\.tsx?$/.test(path)) return []
      let staged
      try {
        staged = execSync(`git show :"${path}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })
      } catch {
        return [] // untracked or no git — nothing to diff against
      }
      const surface = (s) => s.split('\n').filter((l) => l.startsWith('export ')).join('\n')
      const doc = (s) => (s.match(/^\/\*\*[\s\S]*?\*\//) || [''])[0]
      if (surface(staged) !== surface(text) && doc(staged) === doc(text) && doc(text) !== '') {
        return [{ line: 1, message: 'export surface changed but the ownership comment did not', suggestion: 're-read the doc comment against what the domain now owns' }]
      }
      return []
    },
  },
]

// ── Runner ───────────────────────────────────────────────────────────────────

function help() {
  const body = rules
    .map((r) => `  ${r.name}  [${r.severity}]\n    ${r.description}`)
    .join('\n\n')
  process.stdout.write(`\nConvention checker\n\n  node scripts/check-conventions.mjs [path…]\n\nRules (generated from the registry that executes them):\n\n${body}\n\n`)
}

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (CODE.has(extname(e.name))) out.push(full)
  }
  return out
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) return help()

  const roots = args.length > 0 ? args : DEFAULT_ROOTS
  const filePaths = []
  for (const r of roots) {
    const full = join(ROOT, r)
    try {
      if (statSync(full).isDirectory()) walk(full, filePaths)
      else filePaths.push(full)
    } catch {
      /* a root that does not exist is not an error — roots are shared across repos */
    }
  }

  // Read every file once; both per-file check and checkAll consume this.
  //
  // POSIX SEPARATORS, ALWAYS. Every rule below asks questions like
  // `path.startsWith('src/')`, and every budget is keyed by a posix path — on
  // Windows `relative()` hands back `src\\provider\\...`, so the src/ checks
  // stopped matching (test files were scanned as source: 77 errors) and every
  // budget key missed its file ("measured 0 < budget 1"). The CI matrix found
  // it on the one runner that is not a unix; normalising here is the whole fix.
  const files = filePaths
    .map((f) => ({ path: relative(ROOT, f).split(sep).join('/'), abs: f }))
    .filter((f) => f.path !== SELF)
    .map((f) => ({ path: f.path, text: readFileSync(f.abs, 'utf8') }))

  const diagnostics = []
  for (const file of files) {
    // Blank out comments before line-based checks: a rule that fires on prose
    // describing the rule trains everyone to ignore it.
    const lines = file.text.split('\n').map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l))
    for (const rule of rules) {
      if (rule.check) {
        for (const hit of rule.check({ path: file.path, text: file.text, lines })) {
          diagnostics.push({ rule: rule.name, severity: rule.severity, path: file.path, ...hit })
        }
      }
    }
  }
  // Cross-file rules run once over the whole set.
  for (const rule of rules) {
    if (rule.checkAll) {
      for (const hit of rule.checkAll(files)) {
        diagnostics.push({ rule: rule.name, severity: rule.severity, ...hit })
      }
    }
  }

  // Apply the shrinking allowlist. A file at its grandfathered count passes; over
  // it fails with the delta; UNDER it also fails, so headroom can't hide a new
  // violation and a fixed file must drop its entry.
  const byRuleFile = new Map()
  for (const d of diagnostics) {
    byRuleFile.set(`${d.rule}\u0000${d.path}`, (byRuleFile.get(`${d.rule}\u0000${d.path}`) ?? 0) + 1)
  }
  const kept = []
  for (const d of diagnostics) {
    const budget = GRANDFATHERED.get(d.rule)?.get(d.path)
    if (budget === undefined) { kept.push(d); continue }
    const actual = byRuleFile.get(`${d.rule}\u0000${d.path}`) ?? 0
    if (actual > budget) kept.push({ ...d, message: `${d.message} (${actual} in this file, budget ${budget} — the budget only goes down)` })
  }

  // Budget-exactness: a grandfathered file measured strictly below its budget, or
  // gone entirely, must lower or remove the entry in the same commit.
  for (const [rule, fileMap] of GRANDFATHERED) {
    for (const [path, budget] of fileMap) {
      const actual = byRuleFile.get(`${rule}\u0000${path}`) ?? 0
      if (actual < budget) {
        kept.push({ rule, severity: 'error', path, line: 1, message: `measured ${actual} < budget ${budget} — lower the budget in this commit`, suggestion: actual === 0 ? 'remove the entry' : `set the budget to ${actual}` })
      }
    }
  }

  const errors = kept.filter((d) => d.severity === 'error')
  const warnings = kept.filter((d) => d.severity === 'warning')

  for (const d of [...errors, ...warnings]) {
    const tag = d.severity === 'error' ? 'error' : 'warn '
    process.stderr.write(`${tag}  ${d.path}:${d.line}  ${d.rule}: ${d.message}\n`)
    if (d.suggestion) process.stderr.write(`       → ${d.suggestion}\n`)
  }

  process.stdout.write(
    `\nconventions: ${files.length} files, ${errors.length} error(s), ${warnings.length} warning(s)\n`,
  )
  if (errors.length > 0) process.exit(1)
}

main()
