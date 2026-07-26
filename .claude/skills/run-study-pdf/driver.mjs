#!/usr/bin/env node
/**
 * Driver for the Study PDF Obsidian plugin.
 *
 * There is no headless way to run this plugin: it only exists inside a running
 * Obsidian, and every interesting behaviour (viewer internals, popups, selection,
 * the reload curtain, the bytes written into the .pdf) is live-only. This wraps
 * the `obsidian` CLI so an agent can link a working-tree build into the connected
 * vault, drive a real PDF view programmatically, and read back what happened --
 * including re-parsing the .pdf on disk to prove an annotation was really written.
 *
 * Run `node .claude/skills/run-study-pdf/driver.mjs help` for the command list.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, lstatSync, unlinkSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PDFDocument, StandardFonts, rgb, PDFName } from '@cantoo/pdf-lib';

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SKILL_DIR, '../../..');
const PLUGIN_ID = 'study-pdf';
// Outside the repo on purpose: this holds a copy of the *vault's* released build,
// which must survive a `git clean` and must never be committed.
const BACKUP = join(homedir(), '.cache', 'study-pdf-driver', 'released-build');
/** Vault-relative path of the scratch PDF `fixture` writes. Never a real file. */
const SCRATCH = 'pdf-test/__study-pdf-scratch.pdf';
const PLUGIN_FILES = ['main.js', 'manifest.json', 'styles.css'];

const die = (msg) => { console.error(`driver: ${msg}`); process.exit(1); };

const isRealFile = (p) => existsSync(p) && !lstatSync(p).isSymbolicLink();

/** JS expression yielding the front PDF view's non-blank text-layer spans. Scoped
 *  to one leaf on purpose: a vault usually has several PDF tabs open, and a bare
 *  `.textLayer span` silently mixes in spans from files you aren't driving. */
const SPANS = `[...(app.workspace.getLeavesOfType('pdf')
	.find(l => l === app.workspace.getMostRecentLeaf())?.view?.containerEl ?? document)
	.querySelectorAll('.textLayer span')].filter(s => s.textContent.trim())`;

/** Brings the PDF tab for `vaultPath` to the front. Load-bearing before anything
 *  that measures or taps: an unfocused Obsidian still renders, but a background
 *  *tab* does not, and elementFromPoint would hit whatever tab is actually front. */
function focusPdf(vaultPath) {
	const focused = focusOnly(vaultPath);
	// Every write reloads the PDF view, tearing the text layer down and rebuilding
	// it -- and a background tab doesn't rebuild at all. So after focusing, wait for
	// spans to come back before measuring anything, or you get a confusing "no such
	// span" a second after the same span worked fine.
	//
	// The screenshot in the loop is not debugging: while the Obsidian window is
	// unfocused (which it always is when an agent drives it), macOS stops
	// compositing it and pdf.js's page rendering stalls at `.page.loading` forever
	// -- 30s of polling changes nothing. Capturing a frame forces a paint, and the
	// render resumes. This is the only reliable way to make a background PDF render.
	for (let i = 0; i < 40; i++) {
		if (Number(evalIn(`String(${SPANS}.length)`)) > 0) return focused;
		cli('dev:screenshot', `path=${join(tmpdir(), 'study-pdf-driver-poke.png')}`);
		execFileSync('sleep', ['0.4']);
	}
	die(`the text layer of ${vaultPath} never appeared (scanned/image-only PDF?)`);
}

function focusOnly(vaultPath) {
	return evalIn(`(() => {
		const leaves = app.workspace.getLeavesOfType('pdf');
		const leaf = leaves.find(l => l.view.file?.path === ${JSON.stringify(vaultPath)});
		if (!leaf) return 'no PDF tab open for ' + ${JSON.stringify(vaultPath)};
		app.workspace.revealLeaf(leaf);
		app.workspace.setActiveLeaf(leaf, { focus: true });
		return 'focused ' + leaf.view.file.path;
	})()`);
}

/** Runs an `obsidian` CLI command. Args are passed as an array, so values may
 *  contain spaces, quotes and newlines without any shell quoting. */
function cli(...args) {
	let out;
	try {
		out = execFileSync('obsidian', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	} catch (e) {
		die(`obsidian ${args[0]} failed: ${(e.stderr || e.stdout || e.message).trim()}`);
	}
	// Every successful reply is prefixed with "=> ".
	return out.replace(/^=> /, '').trimEnd();
}

/** Evaluates JS in the Obsidian renderer. The code must evaluate to a string
 *  (JSON.stringify whatever you want back) -- objects come back as "[object Object]". */
function evalIn(code) {
	const out = cli('eval', `code=${code}`);
	if (out.startsWith('Command "eval" not found')) {
		die('eval is unavailable: no community plugin is enabled in the connected vault.\n' +
			'        Fix with: obsidian plugin:enable id=study-pdf');
	}
	return out;
}

const evalJson = (code) => {
	const raw = evalIn(code);
	try { return JSON.parse(raw); } catch { die(`expected JSON from eval, got: ${raw}`); }
};

// --- vault identity -------------------------------------------------------

/** The CLI's `vault=<name>` option is silently ignored -- every command hits
 *  whichever vault owns ~/.obsidian-cli.sock. So the vault is discovered, never
 *  chosen, and anything that writes has to confirm which one it reached first. */
function vaultInfo() {
	return evalJson('JSON.stringify({name: app.vault.getName(), path: app.vault.adapter.basePath})');
}

function requireVault() {
	const v = vaultInfo();
	const expected = process.env.STUDY_PDF_VAULT;
	if (expected && v.name !== expected) {
		die(`connected vault is "${v.name}", expected "${expected}". Refusing to touch it.\n` +
			'        There is no CLI way to switch vaults; focus the right one in Obsidian.');
	}
	return v;
}

// --- commands -------------------------------------------------------------

const commands = {
	help() {
		console.log(`usage: node .claude/skills/run-study-pdf/driver.mjs <command> [args]

  doctor                 check the CLI, the socket, the connected vault, eval/dev:*
  link                   back up the vault's released build, symlink the working tree
  unlink                 restore the released build (always run this when done)
  build                  npm run build
  reload                 build + plugin:reload
  fixture                write a 2-page text PDF to ${SCRATCH} in the vault
  open <vault-path>      open a file (defaults to the scratch PDF) and wait for it
  focus [vault-path]     bring that PDF tab to the front and wait for its text layer
  spans [n]              list the first n text-layer spans with their viewport rects
  select <i> [j]         select text-layer spans i..j and let the plugin see it
  popup                  dump the plugin popup's HTML (empty if none is showing)
  click <css>            click a button inside the popup, e.g. '[aria-label="Green"]'
  type <text>            fill the popup's note textarea
  tap <x> <y>            synthetic touch tap (pointerdown/up, pointerType=touch)
  tapspan <i>            synthetic touch tap on the centre of span i
  command <id>           run an Obsidian command (e.g. study-pdf:list-highlights)
  esc                    dismiss any open modal (list-highlights leaves one up)
  annots [vault-path]    re-parse the PDF on disk, report its /Highlight annots
  shot <abs-path>        screenshot to an ABSOLUTE path
  errors | console       plugin errors / console buffer
  cleanup                delete the scratch PDF + its (highlights)/(flashcards)
                         notes, close its tab, then unlink
`);
	},

	doctor() {
		const v = requireVault();
		const enabled = cli('plugins:enabled').split('\n').includes(PLUGIN_ID);
		const linked = existsSync(join(v.path, '.obsidian/plugins', PLUGIN_ID, 'main.js')) &&
			lstatSync(join(v.path, '.obsidian/plugins', PLUGIN_ID, 'main.js')).isSymbolicLink();
		console.log(JSON.stringify({ vault: v.name, path: v.path, pluginEnabled: enabled, workingTreeLinked: linked }, null, 2));
		if (!enabled) console.log('\nNOTE: plugin disabled -> eval and every dev:* command disappear too.');
	},

	link() {
		const v = requireVault();
		const dir = join(v.path, '.obsidian/plugins', PLUGIN_ID);
		if (!existsSync(dir)) die(`${PLUGIN_ID} is not installed in "${v.name}"; install it from the community browser first`);
		// Back up BEFORE the first ln -sf: that call deletes the released build's
		// real files. Only ever back up real files, never a previous run's symlink.
		mkdirSync(BACKUP, { recursive: true });
		for (const f of PLUGIN_FILES) {
			const src = join(dir, f);
			if (isRealFile(src) && !existsSync(join(BACKUP, f))) copyFileSync(src, join(BACKUP, f));
		}
		// Refuse rather than link over symlinks we have no backup for. That state means
		// someone linked by hand (the ln -sf line in CLAUDE.md) and the released build
		// is already gone -- linking again would cement it, and `unlink` would then
		// leave the plugin directory empty, which un-registers the plugin and takes
		// `eval` and every dev:* command down with it.
		const unbacked = PLUGIN_FILES.filter((f) => !existsSync(join(BACKUP, f)));
		if (unbacked.length) {
			die(`no backup of the released build for: ${unbacked.join(', ')}\n` +
				`        ${dir} already holds symlinks or is incomplete, so there is nothing safe to restore later.\n` +
				`        Reinstall Study PDF from the community browser (or copy a released main.js/manifest.json/styles.css\n` +
				`        into ${BACKUP}), then run link again.`);
		}
		for (const f of PLUGIN_FILES) {
			const dest = join(dir, f);
			try { unlinkSync(dest); } catch { /* already gone */ }
			execFileSync('ln', ['-sf', join(REPO, f), dest]);
		}
		console.log(`linked working tree into ${dir}\nbackup of released build: ${BACKUP}`);
	},

	unlink() {
		const v = requireVault();
		const dir = join(v.path, '.obsidian/plugins', PLUGIN_ID);
		// Never delete before confirming there is something to put back. Deleting the
		// symlinks with no backup empties the plugin directory, which un-registers the
		// plugin: `plugin:reload` then answers Plugin "study-pdf" not found, and
		// (per CLAUDE.md) losing the only enabled community plugin removes `eval` and
		// every dev:* command as well. Recovering needs app.plugins.loadManifests().
		const missing = PLUGIN_FILES.filter((f) => !existsSync(join(BACKUP, f)));
		if (missing.length) {
			if (PLUGIN_FILES.every((f) => isRealFile(join(dir, f)))) {
				console.log('nothing to unlink: the released build is already in place');
				return;
			}
			die(`refusing to unlink -- no backed-up released build for: ${missing.join(', ')}\n` +
				`        Deleting the symlinks now would leave ${dir} empty and un-register the plugin.\n` +
				`        Reinstall Study PDF from the community browser instead, then delete ${BACKUP}.`);
		}
		for (const f of PLUGIN_FILES) {
			const dest = join(dir, f);
			try { unlinkSync(dest); } catch { /* already gone */ }
			copyFileSync(join(BACKUP, f), dest);
		}
		rmSync(BACKUP, { recursive: true, force: true });
		// Reload, never disable: disabling the plugin takes eval and dev:* with it.
		console.log(cli('plugin:reload', `id=${PLUGIN_ID}`));
		console.log(`restored the released build in ${dir}`);
	},

	build() {
		execFileSync('npm', ['run', 'build'], { cwd: REPO, stdio: 'inherit' });
	},

	reload() {
		commands.build();
		console.log(cli('plugin:reload', `id=${PLUGIN_ID}`));
	},

	async fixture() {
		const v = requireVault();
		const out = join(v.path, SCRATCH);
		mkdirSync(dirname(out), { recursive: true });
		const doc = await PDFDocument.create();
		const font = await doc.embedFont(StandardFonts.Helvetica);
		for (let p = 1; p <= 2; p++) {
			const page = doc.addPage([612, 792]);
			for (let i = 0; i < 8; i++) {
				page.drawText(`Page ${p} line ${i}: the quick brown fox jumps over the lazy dog.`,
					{ x: 60, y: 700 - i * 40, size: 14, font, color: rgb(0, 0, 0) });
			}
		}
		writeFileSync(out, await doc.save());
		console.log(`wrote ${out}`);
	},

	focus(vaultPath = SCRATCH) {
		console.log(focusPdf(vaultPath));
		execFileSync('sleep', ['0.5']);
	},

	open(vaultPath = SCRATCH) {
		// Deliberately NOT `obsidian open`: that reuses the active tab, so it silently
		// replaces whatever the user was reading -- and `cleanup` then closes it,
		// losing their tab for good. A fresh tab is ours to open and ours to close.
		console.log(evalIn(`(async () => {
			const f = app.vault.getAbstractFileByPath(${JSON.stringify(vaultPath)});
			if (!f) return 'no such file: ' + ${JSON.stringify(vaultPath)};
			const existing = app.workspace.getLeavesOfType('pdf')
				.find(l => l.view.file?.path === f.path);
			await (existing ?? app.workspace.getLeaf('tab')).openFile(f);
			return 'opened ' + f.path;
		})()`));
		console.log(focusPdf(vaultPath) + ' (text layer ready)');
	},

	spans(n = '12') {
		focusPdf(SCRATCH);
		console.log(JSON.stringify(evalJson(`(() => {
			const spans = ${SPANS}.slice(0, ${Number(n)});
			return JSON.stringify(spans.map((s, i) => {
				const r = s.getBoundingClientRect();
				return { i, text: s.textContent.slice(0, 48),
					x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
			}));
		})()`), null, 2));
	},

	select(i, j = i) {
		focusPdf(SCRATCH);
		console.log(evalIn(`(() => {
			const spans = ${SPANS};
			const a = spans[${Number(i)}], b = spans[${Number(j)}];
			if (!a || !b) return 'no such span (run the spans command first)';
			const range = document.createRange();
			range.setStart(a.firstChild, 0);
			range.setEnd(b.firstChild, b.firstChild.length);
			const sel = window.getSelection();
			sel.removeAllRanges();
			sel.addRange(range);
			// The plugin debounces off selectionchange (200ms) and off mouseup;
			// a synthetic mouseup on the text layer is the desktop path.
			a.closest('.textLayer').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
			return sel.toString().slice(0, 120);
		})()`));
		execFileSync('sleep', ['0.6']);
	},

	popup() {
		console.log(evalIn(`(() => {
			const p = document.querySelector('.study-pdf-popup');
			return p ? p.outerHTML : '(no popup)';
		})()`));
	},

	click(sel) {
		if (!sel) die('click needs a CSS selector');
		console.log(evalIn(`(() => {
			const p = document.querySelector('.study-pdf-popup');
			if (!p) return '(no popup)';
			const el = p.querySelector(${JSON.stringify(sel)});
			if (!el) return '(no match inside popup)';
			el.click();
			return 'clicked: ' + (el.getAttribute('aria-label') || el.className);
		})()`));
		execFileSync('sleep', ['1.5']);
	},

	/** Closes any open modal. list-highlights leaves one up, and every later
	 *  command then runs against a vault the user can't type in. Always follow
	 *  a modal-opening command with this. */
	esc() {
		// A synthetic Escape on document, not a close button: the highlights modal
		// has no .modal-close-button, and Obsidian's keymap is what dismisses it.
		console.log(evalIn(`(() => {
			const n = document.querySelectorAll('.modal-container').length;
			document.dispatchEvent(new KeyboardEvent('keydown',
				{ key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
			return 'closed ' + n + ' modal(s)';
		})()`));
		execFileSync('sleep', ['0.5']);
	},

	type(text) {
		if (text === undefined) die('type needs text');
		console.log(evalIn(`(() => {
			const ta = document.querySelector('.study-pdf-popup textarea');
			if (!ta) return '(no note editor open -- click [aria-label="Add note"] first)';
			ta.value = ${JSON.stringify(text)};
			ta.dispatchEvent(new Event('input', { bubbles: true }));
			return 'typed: ' + ta.value;
		})()`));
	},

	tap(x, y) {
		console.log(tapAt(Number(x), Number(y)));
		execFileSync('sleep', ['1']);
	},

	tapspan(i) {
		focusPdf(SCRATCH);
		const spans = evalJson(`(() => {
			const s = ${SPANS}[${Number(i)}];
			if (!s) return 'null';
			const r = s.getBoundingClientRect();
			return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
		})()`);
		if (!spans) die('no such span');
		console.log(tapAt(spans.x, spans.y));
		execFileSync('sleep', ['1']);
	},

	command(id) {
		if (!id) die('command needs an id, e.g. study-pdf:list-highlights');
		// Every study-pdf command is a checkCallback gated on an active PDF view, so
		// it silently no-ops when something else is in front -- and export-highlights
		// itself opens the generated note, stealing focus from the very next command.
		if (id.startsWith('study-pdf:')) focusPdf(SCRATCH);
		console.log(cli('command', `id=${id}`));
		execFileSync('sleep', ['1.5']);
	},

	annots(vaultPath = SCRATCH) {
		const v = vaultInfo();
		const bytes = readFileSync(join(v.path, vaultPath));
		return PDFDocument.load(bytes, { ignoreEncryption: true }).then((doc) => {
			const found = [];
			doc.getPages().forEach((page, pageIndex) => {
				const arr = page.node.Annots();
				for (let k = 0; k < (arr?.size() ?? 0); k++) {
					const a = arr.lookup(k);
					const sub = a?.get?.(PDFName.of('Subtype'))?.asString?.();
					if (sub !== '/Highlight') continue;
					const contents = a.get(PDFName.of('Contents'));
					found.push({
						pageIndex,
						rect: a.get(PDFName.of('Rect'))?.asArray?.().map((n) => Math.round(n.asNumber())),
						color: a.get(PDFName.of('C'))?.asArray?.().map((n) => +n.asNumber().toFixed(2)),
						note: contents ? String(contents.decodeText?.() ?? contents) : null,
					});
				}
			});
			console.log(JSON.stringify({ file: vaultPath, highlights: found }, null, 2));
		});
	},

	shot(path) {
		if (!path || !path.startsWith('/')) die('shot needs an ABSOLUTE path (a relative one lands somewhere unhelpful)');
		// Twice on purpose. macOS stops compositing an unfocused window, so the first
		// capture after any change returns the *previous* frame -- byte-identical to
		// the last screenshot, showing none of what you just did. The first call is
		// what wakes the compositor; the second is the one you can trust.
		cli('dev:screenshot', `path=${path}`);
		execFileSync('sleep', ['0.7']);
		console.log(cli('dev:screenshot', `path=${path}`));
	},

	errors() { console.log(cli('dev:errors')); },
	console() { console.log(cli('dev:console', 'limit=40')); },

	cleanup() {
		const v = vaultInfo();
		// The export command writes a sibling "<name> (highlights).md" -- leaving it
		// behind litters the user's vault with a note about a PDF that no longer exists.
		// export-highlights and sync-flashcards each write a sibling note AND open it
		// in a tab. Leaving them behind litters the user's real vault with notes about
		// a PDF that no longer exists.
		const siblings = [' (highlights).md', ' (flashcards).md']
			.map((suffix) => SCRATCH.replace(/\.pdf$/, suffix));
		const scratchPaths = [SCRATCH, ...siblings];
		// Close the tabs BEFORE deleting the files. Obsidian's vault index lags the
		// filesystem by a moment, so a "does this leaf's file still exist?" sweep run
		// straight after the unlink finds nothing stale and leaves dead tabs behind.
		console.log(evalIn(`(() => {
			const paths = ${JSON.stringify(scratchPaths)};
			// Collect first, detach after: detaching mid-iterateAllLeaves mutates the
			// tree being walked and silently skips the next leaf.
			const doomed = [];
			app.workspace.iterateAllLeaves(l => { if (paths.includes(l.view.file?.path)) doomed.push(l); });
			doomed.forEach(l => l.detach());
			return 'closed ' + doomed.length + ' scratch tab(s)';
		})()`));
		for (const rel of scratchPaths) {
			const p = join(v.path, rel);
			if (existsSync(p)) { unlinkSync(p); console.log(`deleted ${p}`); }
		}
		commands.unlink();
	},
};

/** A synthetic touch tap. The plugin listens on pointerdown/pointerup filtered on
 *  pointerType !== 'mouse', so this exercises the real mobile tap path from a
 *  desktop vault -- no phone needed. */
function tapAt(x, y) {
	return evalIn(`(() => {
		const el = document.elementFromPoint(${x}, ${y});
		if (!el) return 'nothing at that point';
		// view: window is load-bearing, not boilerplate. Without it PointerEvent.view
		// is null, and Obsidian's own annotation handler (evt.view.getSelection())
		// throws before the plugin's listener ever runs.
		const opts = { view: window, bubbles: true, cancelable: true, composed: true,
			pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: ${x}, clientY: ${y} };
		el.dispatchEvent(new PointerEvent('pointerdown', opts));
		el.dispatchEvent(new PointerEvent('pointerup', opts));
		return 'tapped ' + el.tagName + '.' + el.className + ' @ ${x},${y}';
	})()`);
}

const [cmd, ...args] = process.argv.slice(2);
const fn = commands[cmd ?? 'help'];
if (!fn) die(`unknown command "${cmd}" (try: help)`);
await fn(...args);
