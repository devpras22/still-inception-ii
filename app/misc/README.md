# misc/ | the README's imagery, and where each picture came from

Three files, and they are not the same KIND of thing. A marketing picture that
quietly stops matching the product is the same failure as an audit that quietly
stops matching the code, so each one records how it was made and what would make
it stale.

### `banner.png` | composed, regenerable

Built by [`scripts/brand.mjs`](../scripts/brand.mjs) from two live sources: the
palette and vendored typeface in `src/theme/styles.css`, and `play.png` below.
Nothing about it is hand-placed colour. Change the theme and re-run:

```sh
node scripts/brand.mjs --banner     # needs no server
```

The script reads the tokens rather than restating them, and fails loudly if
`styles.css` stops defining one — so a palette change cannot leave a banner
wearing the old brand.

### `editor.png` | photographed, regenerable

A real browser against a real dev server, driven by the same script. Not a mockup:
the doctrine warnings, the fix buttons, the minimap and the inspector's fields are
whatever the studio actually rendered that run.

```sh
npm run dev
node scripts/brand.mjs --editor
```

The world in it is the same one `play.png` shows, on purpose — the two pictures
are the same five states, once as a graph and once running.

### `play.png` | archived, NOT regenerable

A single frame from a real Reactor session: the studio driving a live world model,
with authored events rendered as clickable chips over the picture. It is committed
as an artifact rather than regenerated because reproducing it costs a paid session
against a third-party API, which nothing in this repository should require.

Captured 2026-08-02 from world `w_msbgvmks830c0989` ("Beaver Atlantis") on the
`reactor` provider. It is a photograph of a session, not a render, and it has not
been retouched.
