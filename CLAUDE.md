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

`main.js` at the repo root is a build artifact and is **gitignored** — CI rebuilds it for
each release. Never hand-edit it, and don't expect it in a diff.

## Testing in a live Obsidian

Unit tests only cover the pure modules. Everything involving the viewer, popups,
selection, or the reload curtain has to be checked in a running Obsidian via the
`obsidian` CLI — do not call a UI change verified on `npm test` alone.

**No vault is linked to this repo.** Test vaults run whatever the Obsidian community
browser installs, so a local build reaches none of them and `plugin:reload` reloads the
*released* build rather than the working tree. Editing here and re-running the live checks
below without linking first silently tests the wrong code.

To develop against a vault, link the build into it, and remove the link when done so the
vault goes back to the released build:

```bash
P="<vault>/.obsidian/plugins/study-pdf"
mkdir -p "$P" && for f in main.js manifest.json styles.css; do ln -sf "$PWD/$f" "$P/$f"; done
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

The CLI's `vault=<name>` option is **silently ignored**: it lists every known vault,
but every command runs against whichever vault is connected to `~/.obsidian-cli.sock`
— `obsidian eval vault=X code='app.vault.getName()'` returns that vault's name for
any `X`, and `obsidian files vault=X` returns identical listings for two different
vaults. Check which vault you actually reached before trusting a live result, and if
it's the wrong one, there is no CLI way to switch (window focus can't be scripted
without accessibility permission).

`eval`, `vault` and the `dev:*` commands also **disappear when no community plugin is
enabled** in the connected vault — they're listed in `--help` but every call answers
`Command "eval" not found. It may require a plugin to be enabled.` Re-enabling any
community plugin (`obsidian plugin:enable id=study-pdf`) brings them straight back, so
disabling the plugin at the end of a session is what takes the debugging tools with it.

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
- **iOS ignores `::selection` in the PDF text layer.** WKWebView paints its own faint
  native selection tint there and honours no `::selection` background at all — not the
  plugin's rule, not Obsidian's, not pdf.js's. Confirmed on-device: a deliberately garish
  `.textLayer×4 ::selection { background: red }` at the highest specificity in the whole
  cascade rendered red on desktop and stayed pale blue on an iPhone, with an on-device dump
  proving that exact rule was loaded. Don't "fix" the washed-out mobile selection with
  specificity bumps or `!important` — no CSS reaches it. This is why `selection-overlay.ts`
  exists: on iOS only, the selection is painted as real elements (what CodeMirror does for
  the editor, which is why notes look stronger than PDFs there). The committed `/Highlight`
  annotation renders correctly regardless — only the pre-commit selection is affected.
- **While a native iOS selection is up, WKWebView swallows a tap's `pointerdown` and
  delivers only `pointerup`.** Anything that measures a tap must fall back to the
  `pointerup` coordinates (`??=`, so a real `pointerdown` still wins where both arrive —
  a long-press releases well away from where it started, often outside the selection it
  just created). Confirmed from an on-device log, not inferred.
- **iOS does not collapse a selection when you tap away from it.** The selection, its
  native handles, and any popup all stay. `selection !== null` is therefore not evidence
  the user still wants one; the plugin decides from the press position via
  `pointWithinRects` (geometry.ts) and drops the selection itself.
- Four separate fixes for the mobile popup bugs were each verified against a *desktop
  simulation* of what iOS was assumed to be doing, and each simulation was wrong in a
  different way. What finally worked was a temporary ring buffer logging
  pointer/selection events to a vault note, dumped from the phone via a debug command.
  For any iOS-only behaviour, record what the device actually does before theorising —
  the round trip is cheaper than a confident wrong fix.
- **Pinch-zoom flicker and page-jumping on iOS are not this plugin's.** Confirmed by the
  cleanest possible control: with Study PDF fully disabled, an iPhone still flickers each
  page blank while pdf.js re-rasterises at the new scale, and still sometimes lands on a
  different page. Don't re-investigate from inside the plugin — it registers no zoom,
  scale or resize listener at all, and the reload curtain only ever appears on writes.
  (The multi-touch guard in the pointer handlers is still worth having: a pinch used to be
  read as two taps, which re-parsed the whole PDF twice per gesture and could pop a spurious
  popup. That is a real fix, but it is not a fix for the flicker.)
- Touch taps reach `mousedown`/`mouseup` only as *compatibility* mouse events, which the
  engine synthesizes after `touchend` and silently suppresses whenever the gesture wasn't a
  clean tap (a few px of thumb travel, a long-press promoted to selection, a `preventDefault`
  in the touch sequence). Anything that must respond to a tap listens on `pointerdown`/
  `pointerup` *in addition to* the mouse events, filtered on `evt.pointerType !== 'mouse'`
  — never as a replacement, since the desktop drag-selection path depends on the mouse pair.
- **Do not ignore `pointercancel`** (an earlier version of this file said to, and it was
  wrong). iOS fires it *instead of* `pointerup` whenever the compositor might want the
  gesture, which inside a scrollable PDF is most touches — often after a pixel or two of
  thumb travel with no scroll ever happening. Dropping them all makes tapping work only
  sometimes; honouring them all turns every scroll and long-press into a tap. Judge the
  cancelled touch on travel and duration instead (`tap-gesture.ts`), with generous slop:
  a thumb drifts 6-8px, and too tight a threshold reinstates the bug.
- A pinch is **two** pointers and each ends with its own `pointerup`, so anything treating
  a `pointerup` as a tap fires twice per zoom. `activePointers`/`isMultiTouchGesture` in
  `main.ts` latch on the second finger and hold until the last one lifts.
- Both touch paths above are testable on the desktop dev vault without a phone — dispatch
  synthetic `PointerEvent`s with `pointerType: 'touch'` at a real annotation's centre via
  `obsidian eval` and assert on `.study-pdf-popup`. Stashing the change and re-running the
  same dispatch is a cheap control for "does this actually fix it".
- `app.emulateMobile(true)` does **not** verify `@media (pointer: coarse)` rules. It adds
  Obsidian's `is-mobile` class, but the Electron window keeps a fine pointer, so
  `matchMedia("(pointer: coarse)")` stays `false` and the rules never apply. To exercise
  them on the desktop dev vault, flip the live rule's condition and measure real elements:

  ```js
  // obsidian eval — find the block, retarget it, measure, restore
  for (const s of document.styleSheets) for (const r of s.cssRules)
    if (r.type === 4 && r.conditionText?.includes('coarse')) r.media.mediaText = '(pointer: fine)';
  ```

  That covers sizing, but viewport-relative parts (`90vw` wrapping, `min(240px, 70vw)`)
  resolve to their desktop branch and still need a narrow pane or a real device.

## Lint and release

ESLint is scoped to `src/` on purpose: obsidianmd's `no-nodejs-modules` rule would flag
test helpers that legitimately use `node:fs`/`node:url`. Two rules are downgraded to
warnings for version-gated calls in `src/settings.ts`, with the reasoning at each call site.

Releases are built only by GitHub Actions from a pushed tag matching `0.2.1` (no `v`
prefix); CI fails if `manifest.json`'s version doesn't match the tag. Bump with
`npm version <x.y.z>`, which runs `version-bump.mjs` to sync `manifest.json` and
`versions.json`. Never upload release assets from a local machine.
