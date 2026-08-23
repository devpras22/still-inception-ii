# Contributing

Contributions are welcome: bug reports, provider implementations, doctrine
rules, docs. This file is short because most of what a contributing guide usually
says is enforced by a command instead.

## The gate

```sh
npm run check
```

Typecheck, conventions, unit tests, end-to-end tests. It is exactly what CI runs,
verbatim. If it is green your change is mergeable; if it is red, it is not. Do not
bypass it, and if it is broken, fixing it is the change.

## The conventions are executable

There is no style document to read and forget. `npm run check:conventions` runs
every rule this codebase has, and

```sh
npm run check:conventions -- --help
```

prints them all, generated from the registry that executes them, so the
documentation cannot drift from the enforcement. Three of them will surprise you:

- **One concept, one directory, one public face.** Every directory under `src/`
  has an `index.ts` whose doc comment states what it owns and what belongs
  elsewhere. Callers import that face. Reaching into another domain's files is an
  error, not a preference.
- **Budgets only ever go down.** A rule with existing violations carries a
  per-file budget. Adding one more is an error, and so is measuring *below* the
  budget without lowering it, so a cleanup cannot silently leave room for the
  next regression.
- **Nothing secret comes from the environment.** No key is read from a `VITE_`
  variable, because Vite inlines those into the bundle and ships them to every
  visitor. A CI job builds with fake key-shaped canaries in the environment and
  proves none of them stuck. That job is why this project exists as a separate
  repository; do not delete it.

## House style

TypeScript strict, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
and `noPropertyAccessFromIndexSignature`. Two-space indent, single quotes, no
semicolons. No new runtime dependencies without a reason in the PR description.
There are three, and the shipped Docker image has zero.

Comments explain *why*, especially when the obvious thing was tried and did not
work. A comment that restates the line below it is noise; a comment that records
a measurement or a trap is the most valuable thing in the file.

## Claims

If a change is meant to make something work, say how you know. "Verified on a
live Reactor session, 5 of 5 transitions landed" beats "fixed". If an axis is
untested, say which one. An honest blind spot is a contribution, a silent one is
a bug someone else has to find.

## Providers

Adding a world model is the most useful contribution and needs no studio code:
implement the protocol in [docs/WEBSOCKET_PROTOCOL.md](docs/WEBSOCKET_PROTOCOL.md),
which ships a runnable echo server. If your backend cannot accept authored events
mid-session, declare `promptableEvents: false` and the studio will warn the user
rather than let them edit prompts that can never reach the renderer.

## Pull requests

Small, one concern, green gate, plain commit messages in the imperative. Include
a screenshot for anything visual. `node scripts/shot.mjs --help` prints the
harness and the rubric it expects you to apply to the image before calling it
evidence.

By taking part you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md), and you
license your contribution under [Apache-2.0](./LICENSE), the same terms as the
rest of the project.
