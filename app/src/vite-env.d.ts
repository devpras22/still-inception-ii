/// <reference types="vite/client" />

/**
 * The build-time variables this studio reads — and ONLY these.
 *
 * Declared so they can be accessed with a dot: Vite replaces
 * `import.meta.env.VITE_FOO` statically, and a bracket access is not replaced,
 * so an un-declared name would silently ship its default. The list is
 * deliberately short — every name here is a value that ends up inside the
 * bundle every visitor downloads, which is why nothing secret may ever join it.
 */
interface ImportMetaEnv {
  readonly VITE_ALAKAZAM_API_BASE?: string
  readonly VITE_ALAKAZAM_EMBED_HOST?: string
}

interface ImportMeta {
  readonly env?: ImportMetaEnv
}
