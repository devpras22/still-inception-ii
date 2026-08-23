/**
 * Parameter schemas: one declaration, four consumers.
 *
 * A parameter is declared once and that single declaration drives argument
 * parsing, validation, the rendered help, and the TypeScript type of the input a
 * tool receives. Anything maintained in two places drifts, and a flag whose help
 * disagrees with its parser is worse than an undocumented flag — it is a
 * documented lie.
 *
 * WHY NOT ZOD. The reference implementations of this pattern are built on Zod,
 * and it is the obvious choice. This repository has three runtime dependencies
 * and hand-rolls its file server and its reference world model against the
 * standard library for exactly that reason; a validation library would be the
 * largest thing in the tree, and it would ship to the browser the moment the app
 * consumed the same tool tree. What is actually needed here is small enough to
 * write: five types, a required flag, an enum, a default, and a sentence. If
 * this ever needs unions, refinements or recursive objects, that is the point to
 * take the dependency rather than to grow a second-rate one.
 */

export type ParamType = 'string' | 'number' | 'boolean' | 'enum' | 'json'

export interface Param {
  type: ParamType
  /**
   * What this parameter means, written for whoever is choosing a value. This is
   * the ONLY place a parameter's semantics are documented — a tool description
   * that restates its own parameters is duplication that will drift.
   */
  describe: string
  /** `true` when the parameter must be supplied. Omit it otherwise; there is no
   *  `required: false`, and typing it as `true` (not `boolean`) is what lets
   *  `Infer` tell a guaranteed value from a maybe-absent one. */
  required?: true
  /** For `enum`: the permitted values, rendered as choices in help. */
  values?: readonly string[]
  default?: string | number | boolean
  /** Accept this parameter as a bare positional argument, in this position. */
  positional?: number
}

export type Params = Record<string, Param>

/** The runtime type of one parameter's value. `json` is `unknown` on purpose —
 *  a caller who passes structured data must narrow it, like any other boundary. */
type Base<T extends ParamType> = T extends 'number'
  ? number
  : T extends 'boolean'
    ? boolean
    : T extends 'json'
      ? unknown
      : string

/** A param is always present when it is required or carries a default; otherwise
 *  the value can be absent, and the inferred type says so. */
type Present<P extends Param> = P['required'] extends true
  ? true
  : undefined extends P['default']
    ? false
    : true

/**
 * The input type a tool's `run` receives, derived from its own parameters. An
 * optional parameter with no default is `T | undefined`, so a leaf that reaches
 * for it without guarding fails to compile rather than at runtime.
 */
export type Infer<P extends Params> = {
  [K in keyof P]: Present<P[K]> extends true ? Base<P[K]['type']> : Base<P[K]['type']> | undefined
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolInputError'
  }
}

/** `--flag value`, `--bool`, `--no-bool`, and bare positionals. */
export function parseArgs(params: Params, argv: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const positionals: string[] = []

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === undefined) continue
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const negated = token.startsWith('--no-')
    const name = camel(negated ? token.slice(5) : token.slice(2))
    const param = params[name]
    if (!param) throw new ToolInputError(`unknown option --${token.replace(/^--(no-)?/, '')}`)
    if (param.type === 'boolean') {
      out[name] = !negated
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      throw new ToolInputError(`--${token.slice(2)} needs a value`)
    }
    out[name] = next
    i += 1
  }

  // Bare arguments fill declared positionals in order.
  const byPosition = Object.entries(params)
    .filter(([, p]) => p.positional !== undefined)
    .sort((a, b) => (a[1].positional ?? 0) - (b[1].positional ?? 0))
  byPosition.forEach(([name], index) => {
    const value = positionals[index]
    if (value !== undefined && out[name] === undefined) out[name] = value
  })

  return coerce(params, out)
}

/** Apply types, defaults and requiredness. Throws on the first violation. */
export function coerce(params: Params, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, param] of Object.entries(params)) {
    let value = raw[name]
    if (value === undefined && param.default !== undefined) value = param.default
    if (value === undefined) {
      if (param.required) throw new ToolInputError(`--${kebab(name)} is required`)
      continue
    }
    switch (param.type) {
      case 'number': {
        const n = typeof value === 'number' ? value : Number(String(value))
        if (!Number.isFinite(n)) throw new ToolInputError(`--${kebab(name)} must be a number`)
        out[name] = n
        break
      }
      case 'boolean':
        out[name] = value === true || value === 'true'
        break
      case 'enum': {
        const s = String(value)
        if (param.values && !param.values.includes(s)) {
          throw new ToolInputError(`--${kebab(name)} must be one of: ${param.values.join(', ')}`)
        }
        out[name] = s
        break
      }
      case 'json': {
        // A string arrives from the CLI and is parsed; structured data (an
        // in-process caller passing an object) passes through untouched. Either
        // way the leaf receives `unknown` and must narrow it.
        if (typeof value === 'string') {
          try {
            out[name] = JSON.parse(value)
          } catch {
            throw new ToolInputError(`--${kebab(name)} must be valid JSON`)
          }
        } else {
          out[name] = value
        }
        break
      }
      default:
        out[name] = String(value)
    }
  }
  // A key the schema does not declare is a typo, not an extension point.
  for (const key of Object.keys(raw)) {
    if (!(key in params)) throw new ToolInputError(`unknown option --${kebab(key)}`)
  }
  return out
}

export function camel(s: string): string {
  return s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

export function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

/** How a parameter renders in help. Read by every help surface, never hand-written. */
export function describeParam(name: string, param: Param): string {
  const flag = `--${kebab(name)}`
  const value =
    param.type === 'boolean'
      ? ''
      : param.type === 'enum'
        ? ` ${param.values?.join('|') ?? 'value'}`
        : param.type === 'number'
          ? ' N'
          : param.type === 'json'
            ? ' JSON'
            : ' TEXT'
  const bits: string[] = []
  if (param.required) bits.push('required')
  if (param.default !== undefined) bits.push(`default ${String(param.default)}`)
  const suffix = bits.length > 0 ? ` (${bits.join(', ')})` : ''
  return `${flag}${value}${suffix}`
}
