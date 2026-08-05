// Masks the flicker of Obsidian's PDF reload. When the PDF file changes on
// disk, Obsidian's PDF view runs a full `viewer.loadFile()` -- it destroys and
// asynchronously rebuilds every page canvas (confirmed by reading Obsidian's
// shipped app.js), which flashes blank pages for a moment. Instead of fighting
// that reload (it also handles subpaths and password prompts), we cover the
// visible pages with pixel-identical snapshots of their current canvases just
// before writing the file, and remove each snapshot as soon as its own page has
// finished re-rendering. Purely cosmetic: if detection ever fails, a timeout
// removes the overlay and behavior degrades to a flicker.
//
// The reload does NOT reliably restore the reading position, which is why the
// per-page release above can't be the only release path -- see isDocumentLive.
import type { App } from 'obsidian';
import { getActivePdfView, type ActivePdfView } from '../obsidian-pdf-internals';

export interface ReloadCurtain {
	/** Tear the curtain down immediately (e.g. the file write failed, so no
	 * reload is coming). */
	cancel(): void;
}

const POLL_INTERVAL_MS = 50;
// The curtain now goes up BEFORE the PDF computation (so the painted highlight
// appears instantly), so the failsafe must cover compute + write + reload.
const TIMEOUT_MS = 4000;
const FADE_MS = 120;
// Once *some* page of the reloaded document has painted, how long to keep
// holding snapshots over the pages that haven't. Long enough for a second
// visible page to finish rendering, short enough that a page the reload
// abandoned can't freeze the view.
const GRACE_MS = 300;

/** A just-created highlight to paint into the page snapshot, so the user sees
 * the result instantly while the actual PDF write + reload happen underneath. */
export interface CurtainPaint {
	/** 1-based page number, as in the DOM's data-page-number. */
	pageNumber: string;
	/** Client-space rects of the new highlight (one per selected line). */
	rects: { left: number; top: number; width: number; height: number }[];
	/** CSS color, e.g. "rgb(255, 235, 59)". */
	color: string;
	opacity: number;
}

interface CapturedPage {
	pageNumber: string;
	oldCanvas: HTMLCanvasElement;
	snapshot: HTMLCanvasElement;
	done: boolean;
}

/** Snapshot the visible page canvases and start watching for the reload to
 * complete. Returns null when there's nothing to mask (no rendered pages in
 * view), which callers should treat as "just write the file normally". */
export function showReloadCurtain(app: App, pdfView: ActivePdfView, paint?: CurtainPaint): ReloadCurtain | null {
	const doc = pdfView.containerEl.ownerDocument;
	const win = doc.defaultView ?? window;
	const file = pdfView.file;

	// Filter to visible pages first, before creating any DOM nodes: Obsidian's
	// createDiv/createEl attach as part of creation (unlike document.createElement,
	// which returns a detached node), so the overlay must not be created -- let
	// alone attached to doc.body -- until we're sure it's actually needed.
	interface VisiblePage {
		pageNumber: string;
		canvas: HTMLCanvasElement;
		rect: DOMRect;
	}
	const visiblePages: VisiblePage[] = [];
	for (const canvas of Array.from(pdfView.containerEl.querySelectorAll<HTMLCanvasElement>('div.page canvas'))) {
		const rect = canvas.getBoundingClientRect();
		if (rect.width === 0 || rect.bottom < 0 || rect.top > win.innerHeight) continue;
		const pageNumber = canvas.closest('div.page[data-page-number]')?.getAttribute('data-page-number');
		if (!pageNumber) continue;
		visiblePages.push({ pageNumber, canvas, rect });
	}
	if (visiblePages.length === 0) return null;

	const overlay = doc.body.createDiv({ cls: 'study-pdf-curtain' });
	const captured: CapturedPage[] = [];

	for (const { pageNumber, canvas, rect } of visiblePages) {
		const snapshot = overlay.createEl('canvas');
		snapshot.width = canvas.width;
		snapshot.height = canvas.height;
		const ctx = snapshot.getContext('2d');
		if (!ctx) {
			snapshot.remove();
			continue;
		}
		ctx.drawImage(canvas, 0, 0);
		if (paint && paint.pageNumber === pageNumber) {
			// Multiply blend + fill opacity mirrors how the real annotation's
			// appearance stream renders, so the painted preview and the final
			// render are near-indistinguishable when the curtain lifts.
			const scaleX = canvas.width / rect.width;
			const scaleY = canvas.height / rect.height;
			ctx.save();
			ctx.globalAlpha = paint.opacity;
			ctx.globalCompositeOperation = 'multiply';
			ctx.fillStyle = paint.color;
			for (const r of paint.rects) {
				ctx.fillRect((r.left - rect.left) * scaleX, (r.top - rect.top) * scaleY, r.width * scaleX, r.height * scaleY);
			}
			ctx.restore();
		}
		snapshot.setCssStyles({
			left: `${rect.left}px`,
			top: `${rect.top}px`,
			width: `${rect.width}px`,
			height: `${rect.height}px`,
		});

		captured.push({ pageNumber, oldCanvas: canvas, snapshot, done: false });
	}

	if (captured.length === 0) {
		overlay.remove();
		return null;
	}

	let released = false;
	let timer = 0;
	const releaseAll = () => {
		if (released) return;
		released = true;
		win.clearTimeout(timer);
		overlay.addClass('is-fading');
		win.setTimeout(() => overlay.remove(), FADE_MS);
	};
	const releaseOne = (page: CapturedPage) => {
		page.done = true;
		page.snapshot.addClass('is-fading');
		win.setTimeout(() => page.snapshot.remove(), FADE_MS);
		if (captured.every((p) => p.done)) releaseAll();
	};

	const oldCanvases = new Set(captured.map((p) => p.oldCanvas));
	/** True once any page of the *reloaded* document has finished painting. This
	 * is deliberately not keyed to a page number: measured live, Obsidian's reload
	 * can land back on page 1 rather than where the reader was, leaving the pages
	 * we snapshotted present but blank and never re-rendered. Waiting for them by
	 * number therefore hung until the failsafe -- 4s on every single write. */
	const isDocumentLive = (view: ActivePdfView): boolean => {
		for (const pageEl of Array.from(view.containerEl.querySelectorAll<HTMLElement>('div.page[data-page-number]'))) {
			const canvas = pageEl.querySelector('canvas');
			if (!canvas || oldCanvases.has(canvas)) continue;
			const pageNumber = parseInt(pageEl.getAttribute('data-page-number') ?? '', 10);
			if (pageNumber > 0 && view.isPageRenderFinished(pageNumber - 1)) return true;
		}
		return false;
	};

	const isPageReady = (view: ActivePdfView, page: CapturedPage): boolean => {
		const canvas = view.containerEl.querySelector<HTMLCanvasElement>(
			`div.page[data-page-number="${page.pageNumber}"] canvas`,
		);
		// The reload replaces every page element, so a *different* canvas that has
		// finished rendering means this page of the new document is on screen.
		return canvas !== null && canvas !== page.oldCanvas && view.isPageRenderFinished(parseInt(page.pageNumber, 10) - 1);
	};

	const startedAt = Date.now();
	let liveAt = 0;
	const poll = () => {
		if (released) return;
		if (Date.now() - startedAt > TIMEOUT_MS) return releaseAll();

		let view: ActivePdfView | null = null;
		try {
			view = getActivePdfView(app);
		} catch {
			return releaseAll(); // internals changed mid-flight; don't leave a stale overlay up
		}
		if (!view || view.file !== file) return releaseAll(); // view closed or switched files

		for (const page of captured) {
			if (!page.done && isPageReady(view, page)) releaseOne(page);
		}
		// A page we snapshotted may simply never come back: the reload can be
		// virtualized past it, or land on a different page entirely and leave it
		// blank. So the moment any page of the new document has painted, start a
		// short grace period for the stragglers and then drop the lot -- a brief
		// flicker beats a frozen snapshot sitting over a live viewer.
		if (!released) {
			if (liveAt === 0 && isDocumentLive(view)) liveAt = Date.now();
			if (liveAt !== 0 && Date.now() - liveAt >= GRACE_MS) return releaseAll();
		}
		if (!released) timer = win.setTimeout(poll, POLL_INTERVAL_MS);
	};
	timer = win.setTimeout(poll, POLL_INTERVAL_MS);

	return { cancel: releaseAll };
}
