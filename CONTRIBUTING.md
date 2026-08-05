# Contributing

## Bug fixes

Pull requests that fix bugs are welcome — send them straight in. A short
description of the bug, how to reproduce it, and what the fix does is enough.
If the bug is in one of the pure modules (`geometry.ts`, `annotate.ts`,
`pdf-text-extraction.ts`, `highlight-export.ts`, `flashcards.ts`), a failing
test that the fix turns green is the best possible description.

## New features

**Please open an issue before writing a feature.** A feature PR that arrives
without that conversation is usually not helpful: it may not fit where the
plugin is going, it may duplicate something already in progress, or it may need
a different design than the one it was built with — and by then someone has
already done the work. That's a bad trade for you and an awkward one for me.

So: open an issue describing what you want and why, we agree on whether and how
it belongs here, and then the PR is a formality. Issues proposing features are
welcome even if you don't intend to implement them.

## Before you open a PR

```bash
npm test        # vitest
npm run build   # typecheck + production build
npm run lint    # must exit clean
```

Anything touching the viewer, popups, or text selection isn't covered by the
unit tests and has to be checked in a running Obsidian — see
[Development](README.md#development) in the README for the setup, and
[CLAUDE.md](CLAUDE.md) for the platform traps (especially the iOS ones) that
are easy to rediscover the slow way.

Match the surrounding code style; keep comments for the parts that are actually
subtle. Don't bump the version or edit `main.js` — it's a build artifact, and
releases are cut by CI from a tag.
