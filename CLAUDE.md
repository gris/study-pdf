# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Study PDF is an Obsidian plugin that writes real PDF `/Highlight` annotations into
the `.pdf` file itself. See `README.md` for the user-facing feature list, code map,
and known limitations — this file covers the parts that only show up across files.

## Commands

```bash
npm run dev                            # esbuild watch -> main.js
npm run build                          # tsc --noEmit + production esbuild
npm test                               # vitest run
npx vitest run tests/geometry.test.ts  # one file
npx vitest run -t 'quadPoints'         # one test by name
npm run lint                           # eslint-plugin-obsidianmd; must exit clean
```

`main.js` at the repo root is a committed esbuild artifact — never hand-edit it.

## Testing in a live Obsidian

Unit tests only cover the pure modules. Everything involving the viewer, popups,
selection, or the reload curtain has to be checked in a running Obsidian via the
`obsidian` CLI — do not call a UI change verified on `npm test` alone.

The `/Users/gris/joao` vault has `main.js`/`manifest.json`/`styles.css` symlinked to
this repo, so a build is immediately live there; the `psicologia` vault holds copies
and is not a dev target.

```bash
npm run build && obsidian plugin:reload id=study-pdf
```

Then drive and inspect it:

```bash
obsidian dev:errors
obsidian dev:console limit=50
obsidian dev:dom selector='.study-pdf-popup' all
obsidian eval code='app.workspace.getLeavesOfType("pdf").length'
obsidian dev:screenshot path=/tmp/check.png
```

## Architecture

**Internals chokepoint.** `src/obsidian-pdf-internals.ts` is the only module allowed
to touch undocumented Obsidian/PDF.js internals (`view.viewer.child.pdfViewer.pdfViewer`,
`renderAnnotationPopup`). It exposes a typed `ActivePdfView` surface and throws
`INTERNALS_ERROR` loudly when the shape doesn't match, rather than degrading into
wrongly-positioned highlights. New code needing viewer internals extends that surface;
it never reaches into the leaf directly.

**Mutation path** (`main.ts` → `annotate.ts`, with `reload-curtain.ts` over the top).
Every mutation — `performHighlight`, `performRemove`, `performSetNote` — has the same
shape:

1. `showReloadCurtain(...)` **before** any PDF work (so feedback is instant),
2. `vault.readBinary` → an `annotate.ts` function → `vault.modifyBinary`,
3. `curtain.cancel()` on *any* failure path, including "nothing was found to change".

Obsidian auto-reloads the PDF view on file change; nothing refreshes it manually. Skipping
the `cancel()` leaves a stale painted preview on screen claiming a write that didn't happen.

pdf-lib re-serializes the whole document on every save, so `annotate.ts` verifies its own
output (re-parse, page/annotation counts) and aborts loudly. `tests/helpers/complex-fixture.ts`
exists to keep that honest: links, form fields, and untouched pages must survive a round trip.

**Pure vs. Obsidian-bound.** `geometry.ts`, `annotate.ts`, and `pdf-text-extraction.ts`
have no Obsidian or DOM imports — that's why they're the only unit-tested modules, and
why new logic belongs in them rather than in `main.ts` or `src/ui/`. `tests/helpers/pdf-fixture.ts`
loads fixtures through real `pdfjs-dist` so tests use a genuine PDF.js viewport as their
oracle instead of a reimplemented transform.

### Traps confirmed the hard way

- Page-local coordinates are relative to the page's `.textLayer`, **not** `div.page` —
  the outer div's decorative border is included in its bounding rect and offsets every
  highlight.
- Clicks on an existing highlight are consumed by PDF.js's annotation layer before a
  selection forms, so the plugin tracks `lastPdfClick` coordinates rather than reading
  `window.getSelection()` for the remove/note flows.
- The plugin's own popup and Obsidian's native annotation popup collide; the fix is a
  prototype patch of `renderAnnotationPopup` (restored on unload), not event suppression.
- Use `node.instanceOf(HTMLElement)`, not `instanceof` — popout windows have a separate
  element realm.

## Lint and release

ESLint is scoped to `src/` on purpose: obsidianmd's `no-nodejs-modules` rule would flag
test helpers that legitimately use `node:fs`/`node:url`. Two rules are downgraded to
warnings for version-gated calls in `src/settings.ts`, with the reasoning at each call site.

Releases are built only by GitHub Actions from a pushed tag matching `0.2.1` (no `v`
prefix); CI fails if `manifest.json`'s version doesn't match the tag. Bump with
`npm version <x.y.z>`, which runs `version-bump.mjs` to sync `manifest.json` and
`versions.json`. Never upload release assets from a local machine.
