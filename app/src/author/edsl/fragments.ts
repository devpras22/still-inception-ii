/**
 * Stagecraft layer 1 — fragments. Immutable prompt values composed in plain
 * TypeScript.
 *
 * The point of the layer, in the language's own words: Guidance killed its
 * textual template language for a host-language eDSL, and Outlines never built
 * a DSL at all ("host types ARE the spec language"). So there is no parser and
 * no new syntax here — the editor's autocomplete and `tsc` are the front end.
 *
 * THE WHITESPACE LAW: every whitespace run — template-literal newlines and
 * indentation included — collapses to a single space, and the ends are
 * trimmed. That law is the whole reason a fragment can be AUTHORED across
 * several readable lines and still compile byte-exact against prose that was
 * hand-written on one. Deterministic, no exceptions.
 *
 * Plain strings stay legal everywhere a Fragment is, and pass through
 * UNTOUCHED — a world hand-written as strings round-trips byte-exact through
 * the compiler, which is what makes the oracle in `tests/unit/edsl.test.ts`
 * (the shipped starter world, re-authored as a program, deep-equal to the
 * store's own) possible at all.
 */

export class Fragment {
  /** Resolved, whitespace-normalized text. Fragments are VALUES. */
  readonly text: string
  /**
   * Doctrine-lint ids deliberately suppressed for this fragment. A visible
   * exception: the compiler reports the suppression as an `info` diagnostic
   * rather than dropping the finding, because a rule you silently switched off
   * is a rule you will forget you switched off.
   */
  readonly allowed: ReadonlySet<string>

  constructor(text: string, allowed: Iterable<string> = []) {
    this.text = text
    this.allowed = new Set(allowed)
  }

  /** Mark a deliberate doctrine exception. Returns a NEW fragment. */
  allow(lintId: string): Fragment {
    return new Fragment(this.text, [...this.allowed, lintId])
  }

  toString(): string {
    return this.text
  }
}

export type Textish = Fragment | string | number

const EMPTY_SET: ReadonlySet<string> = new Set()

/** Collapse all whitespace runs to single spaces; trim the ends. */
export function normalizeWhitespace(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

/** Resolve any text-ish value to its final string. Fragments were normalized
 *  at construction; plain strings pass through untouched. */
export function textOf(value: Textish): string {
  return value instanceof Fragment ? value.text : String(value)
}

/** The lint-suppression set a text-ish value carries (empty for strings). */
export function allowedOf(value: Textish): ReadonlySet<string> {
  return value instanceof Fragment ? value.allowed : EMPTY_SET
}

/**
 * The tagged template. Interpolations accept fragments, strings and numbers,
 * and an interpolated FRAGMENT contributes its suppressions to the composed
 * one — an `allow()` travels with the prose it excuses.
 *
 *   const SUBJECT = frag`a small brown beaver in a brass diving helmet`
 *   const opening = frag`A third-person rear-view shot of ${SUBJECT}, hovering
 *     over a sunken plaza.`
 */
export function frag(strings: TemplateStringsArray, ...values: Textish[]): Fragment {
  let out = ''
  const allowed: string[] = []
  for (let i = 0; i < strings.length; i += 1) {
    out += strings[i] ?? ''
    if (i < values.length) {
      const value = values[i]
      if (value === undefined) continue
      out += textOf(value)
      for (const id of allowedOf(value)) allowed.push(id)
    }
  }
  return new Fragment(normalizeWhitespace(out), allowed)
}

/** `both(x)` = `{ static: x, dynamic: x }` — the layer pair where the same
 *  prose serves at rest and in motion, which is most of them. */
export function both(value: Textish): { static: string; dynamic: string } {
  const text = textOf(value)
  return { static: text, dynamic: text }
}
