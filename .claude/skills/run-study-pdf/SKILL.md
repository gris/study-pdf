---
name: run-study-pdf
description: Build, run, drive and screenshot the Study PDF Obsidian plugin in a live Obsidian vault. Use when asked to run, start, launch, reload, screenshot, or manually test this plugin, or to confirm a highlight/note/export/flashcard change actually works in the real app rather than only in `npm test`.
---

# Run Study PDF

Study PDF only exists inside a running Obsidian — there is no headless mode, no
dev server, no window to launch. Everything worth checking (viewer internals,
popups, selection, the reload curtain, and the `/Highlight` bytes written into
the `.pdf`) is live-only.

The driver is **[.claude/skills/run-study-pdf/driver.mjs](driver.mjs)**. It wraps
the `obsidian` CLI, which talks to the already-running Obsidian over
`~/.obsidian-cli.sock`. Paths below are relative to the repo root.

```bash
node .claude/skills/run-study-pdf/driver.mjs help
```

## Prerequisites

Already present on this machine; verify rather than install:

- Obsidian running, with the `obsidian` CLI at `/usr/local/bin/obsidian` and a
  live `~/.obsidian-cli.sock`.
- The `study-pdf` plugin installed **and enabled** in the connected vault.
  `eval` and every `dev:*` command vanish if no community plugin is enabled.
- `node_modules` installed (Node 22 works; the build here ran against an existing
  install, not a fresh `npm ci`).

```bash
node .claude/skills/run-study-pdf/driver.mjs doctor
```

Prints the connected vault, whether the plugin is enabled, and whether the
working tree is currently linked. Set `STUDY_PDF_VAULT=<name>` to make every
driver command refuse to touch any other vault.

## Run (agent path)

Full round trip, exactly as run to verify this skill:

```bash
node .claude/skills/run-study-pdf/driver.mjs link
node .claude/skills/run-study-pdf/driver.mjs reload
node .claude/skills/run-study-pdf/driver.mjs fixture
node .claude/skills/run-study-pdf/driver.mjs open
```

`link` backs up the vault's released build to
`~/.cache/study-pdf-driver/released-build/` and symlinks `main.js`,
`manifest.json`, `styles.css` from the working tree. `fixture` writes a
throwaway 2-page text PDF to `pdf-test/__study-pdf-scratch.pdf` **inside the
vault** — never drive a real PDF, the plugin rewrites the file on disk.

Then drive it. Highlight a line:

```bash
node .claude/skills/run-study-pdf/driver.mjs spans 4
node .claude/skills/run-study-pdf/driver.mjs select 1
node .claude/skills/run-study-pdf/driver.mjs popup
node .claude/skills/run-study-pdf/driver.mjs click '[aria-label="Green"]'
node .claude/skills/run-study-pdf/driver.mjs annots
```

`annots` re-parses the `.pdf` from disk with pdf-lib and prints its `/Highlight`
annotations — page, rect, colour, note. That is the assertion that matters; the
on-screen preview can be a stale frame, the file bytes cannot.

Attach a note, then read it back:

```bash
node .claude/skills/run-study-pdf/driver.mjs tapspan 1
node .claude/skills/run-study-pdf/driver.mjs click '[aria-label="Add note"]'
node .claude/skills/run-study-pdf/driver.mjs type 'a note'
node .claude/skills/run-study-pdf/driver.mjs click '[aria-label="Save note"]'
node .claude/skills/run-study-pdf/driver.mjs annots
```

`tapspan` dispatches a synthetic `pointerdown`/`pointerup` with
`pointerType: 'touch'` — that is the **mobile** tap path, exercisable from the
desktop vault with no phone. Tapping an existing highlight opens the
note/trash popup; the buttons are `Add note` / `Edit note` / `Remove highlight`,
and in the note editor `Save note` / `Cancel`.

Commands and screenshots:

```bash
node .claude/skills/run-study-pdf/driver.mjs command study-pdf:export-highlights
node .claude/skills/run-study-pdf/driver.mjs command study-pdf:list-highlights
node .claude/skills/run-study-pdf/driver.mjs esc
node .claude/skills/run-study-pdf/driver.mjs shot /tmp/check.png
node .claude/skills/run-study-pdf/driver.mjs errors
```

Command ids: `highlight-selection`, `list-highlights`, `export-highlights`,
`sync-flashcards`, `remove-highlight-at-selection`, all prefixed `study-pdf:`.
Every one is a `checkCallback` gated on an active PDF view, so `command`
re-focuses the scratch PDF first. `list-highlights` opens a modal that has **no
close button** — follow it with `esc` or the user is left with a stuck dialog.

`export-highlights` and `sync-flashcards` each write a **sibling note next to the
PDF** — `<name> (highlights).md` and `<name> (flashcards).md`. `sync-flashcards`
turns each highlight's note into the front of a `::` card:

```
#flashcards

## Page 1

Q what is this? / A a smoke test :: Page 1 line 1: the quick brown fox … — [[…|p. 1]]
```

`cleanup` deletes both siblings and closes their tabs. `sync-flashcards` writes
nothing when no highlight carries a note — the note is the card's front.

Removing a highlight:

```bash
node .claude/skills/run-study-pdf/driver.mjs tapspan 1
node .claude/skills/run-study-pdf/driver.mjs click '[aria-label="Remove highlight"]'
node .claude/skills/run-study-pdf/driver.mjs annots   # -> "highlights": []
```

**Always finish with cleanup** — it closes the scratch tabs, deletes the scratch
PDF and its generated notes, restores the vault's released build, and reloads:

```bash
node .claude/skills/run-study-pdf/driver.mjs cleanup
```

## Direct invocation (no Obsidian)

`geometry.ts`, `annotate.ts`, `pdf-text-extraction.ts`, `flashcards.ts` and
`highlight-export.ts` have no Obsidian or DOM imports, so a change in them can be
exercised in-process. Write a scratch `.ts` **at the repo root** (relative
imports resolve from the file, and `tsx -e` fails with "Top-level await is
currently not supported with the cjs output format"):

```bash
npx tsx scratch.ts
```

Verified contents of such a file:

```ts
import { makeComplexFixturePdfBytes } from './tests/helpers/complex-fixture.ts';
import { addHighlightAnnotation, hasHighlightAt, getStoredQuotes } from './src/annotate.ts';

const before = await makeComplexFixturePdfBytes();
const after = await addHighlightAnnotation(before, {
	pageIndex: 1,
	quadPoints: [20, 265, 200, 265, 20, 245, 200, 245], // flat, length % 8 === 0
	box: { left: 20, bottom: 245, right: 200, top: 265 },
	color: { r: 1, g: 1, b: 0 },
	quote: 'Page 2: this text will be highlighted.',
});
console.log(await hasHighlightAt(after, { pageIndex: 1, box: { left: 30, bottom: 250, right: 60, top: 260 } }));
console.log(await getStoredQuotes(after));
```

## Test / lint

```bash
npm test
```

8 files, 149 tests, ~2.4s. Unit tests cover only the pure modules — they say
nothing about the viewer, popups or selection, so never call a UI change verified
on `npm test` alone.

```bash
npm run lint
```

Exits 0 with 2 known warnings in `src/settings.ts` (deliberately downgraded,
version-gated settings API).

## Gotchas

- **A background Obsidian window never finishes rendering a PDF.** macOS stops
  compositing an unfocused window, and pdf.js's page render stalls at
  `.page.loading` with zero `.textLayer span`s — indefinitely, not slowly.
  Taking a screenshot forces a paint and the render resumes. The driver's
  poll loop fires `dev:screenshot` each iteration for exactly this reason.
  A plain sleep-and-retry will never converge.
- **The first `dev:screenshot` after any change returns the previous frame** —
  byte-identical to the last one, showing none of what you just did. `shot`
  captures twice and keeps the second. If a screenshot looks impossibly stale,
  that's this, not a bug in the plugin.
- **`obsidian` always talks to whichever vault owns the socket.** `vault=<name>`
  is accepted and silently ignored. There is no CLI way to switch. Run `doctor`
  before anything that writes, and set `STUDY_PDF_VAULT` to fail loudly.
- **Every mutation reloads the PDF view**, destroying the text layer. Span
  indices from before a write are meaningless after it; `spans`/`select`/
  `tapspan` re-focus and re-wait automatically, but a raw `tap <x> <y>` at
  coordinates measured before the write will land on nothing.
- **Synthetic `PointerEvent`s need `view: window`.** Without it `event.view` is
  `null` and Obsidian's own annotation handler throws
  `Cannot read properties of null (reading 'getSelection')` before the plugin's
  listener runs — the popup still appears, so this shows up only as noise in
  `dev:errors`.
- **`link` destroys the vault's released build.** `ln -sf` deletes the real
  `main.js`/`manifest.json`/`styles.css` that the community browser installed.
  The driver copies them to `~/.cache/study-pdf-driver/released-build/` first and
  `unlink`/`cleanup` restores them. **Never hand-run the `ln -sf` line from
  `CLAUDE.md`** — `link` and `unlink` both refuse when they find symlinks with no
  backup, precisely because the alternative was verified to be destructive:
  unlink-without-backup deletes the symlinks, leaves the plugin directory
  **empty**, and Obsidian then drops the plugin from `app.plugins.manifests`.
  `plugin:reload` answers `Plugin "study-pdf" not found`, and every `dev:*`
  command goes with it. Recovery is: copy a released build back into the
  directory, then

  ```js
  // obsidian eval
  (async () => { await app.plugins.loadManifests(); await app.plugins.enablePlugin('study-pdf'); })()
  ```

  A plain `plugin:enable` will *not* work — the manifest has to be rescanned first.
- **Unlink, never disable.** Disabling the plugin also removes `eval` and every
  `dev:*` command from the CLI (they need *some* community plugin enabled), so a
  session that ends with `plugin:disable` has thrown away its own tools.
- **A vault usually has several PDF tabs open.** A bare `.textLayer span` query
  mixes spans from files you aren't driving; the driver scopes to the focused
  PDF leaf's `containerEl`.
- **Don't use `obsidian open` for the scratch PDF.** It reuses the active tab, so
  it silently replaces whatever the user was reading — and `cleanup` then closes
  that tab for good. The driver's `open` calls `getLeaf('tab').openFile()` so it
  owns a tab of its own. `cleanup` also closes the scratch tab *before* deleting
  the file: Obsidian's vault index lags the filesystem, so a "is this file gone?"
  sweep run afterwards finds nothing and leaves a dead tab behind.
- Running an Obsidian command can steal focus — `export-highlights` opens the
  generated markdown note in the active tab, so the next `study-pdf:` command
  silently no-ops (its `checkCallback` sees no PDF view) and the next span query
  finds nothing. `command` and the measuring commands re-focus for you.
- **`type` sets `.value` and dispatches `input`** — it does not simulate
  keystrokes, so it exercises nothing about the note editor's key handling
  (Enter-to-save, Escape-to-cancel). A keybinding change needs a real
  `KeyboardEvent`, or a phone.
- **The highlights modal has no `.modal-close-button`.** Clicking one does
  nothing; only a synthetic `Escape` keydown on `document` dismisses it — which
  is what `esc` sends.
- `tapspan` reports hitting either `SECTION.highlightAnnotation` or
  `SPAN.textLayerNode` depending on how far the re-render got. Both work: the
  plugin resolves the target from the recorded click coordinates, not from
  `event.target`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Command "eval" not found. It may require a plugin to be enabled.` | No community plugin is enabled in the connected vault: `obsidian plugin:enable id=study-pdf` |
| `driver: the text layer of … never appeared` | The PDF is scanned/image-only (no text layer at all), or the tab isn't open — run `open` first |
| `driver: no such span` right after a span worked | A write reloaded the view; re-run `focus`, then `spans` |
| Screenshot shows the wrong tab or a pre-change state | Stale frame — `shot` already double-captures; if you called `dev:screenshot` directly, call it twice |
| `annots` shows nothing after a click that reported success | Check `errors`; a failed write cancels the reload curtain and leaves the file untouched by design |
| `Cannot find package '@cantoo/pdf-lib'` | The driver was copied outside the repo — it resolves the repo's `node_modules` from its own location |
| `driver: refusing to unlink -- no backed-up released build` | Someone linked by hand. Reinstall Study PDF from the community browser, then `rm -rf ~/.cache/study-pdf-driver` |
| `Error: Plugin "study-pdf" not found` from `plugin:reload` | The plugin directory was emptied, so Obsidian de-registered it. Restore the three files, then `app.plugins.loadManifests()` + `enablePlugin` via `eval` (see Gotchas) |
| `driver: connected vault is "X", expected "Y"` | `STUDY_PDF_VAULT` doesn't match the vault owning the socket. Focus the right vault in Obsidian — the CLI cannot switch |
