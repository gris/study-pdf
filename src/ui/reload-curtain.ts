// Masks the flicker of Obsidian's PDF reload. When the PDF file changes on
// disk, Obsidian's PDF view runs a full `viewer.loadFile()` -- it destroys and
// asynchronously rebuilds every page canvas (confirmed by reading Obsidian's
// shipped app.js), which flashes blank pages for a moment. Instead of fighting
// that reload (it also handles scroll restore, subpaths, and password prompts),
// we cover the visible pages with pixel-identical snapshots of their current
// canvases just before writing the file, and remove each snapshot as soon as
// its own page has finished re-rendering. Purely cosmetic: if detection ever
// fails, a timeout removes the overlay and behavior degrades to a flicker.
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
	/** On-screen visible area at capture time; the page with the largest area is
	 * the "primary" page whose re-render signals that the new document is live. */
	visibleArea: number;
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

		const visibleArea =
			Math.max(0, Math.min(rect.bottom, win.innerHeight) - Math.max(rect.top, 0)) * rect.width;
		captured.push({ pageNumber, oldCanvas: canvas, snapshot, visibleArea, done: false });
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

	const primary = captured.reduce((a, b) => (b.visibleArea > a.visibleArea ? b : a));
	const isPageReady = (view: ActivePdfView, page: CapturedPage): boolean => {
		const canvas = view.containerEl.querySelector<HTMLCanvasElement>(
			`div.page[data-page-number="${page.pageNumber}"] canvas`,
		);
		// The reload replaces every page element, so a *different* canvas that has
		// finished rendering means this page of the new document is on screen.
		return canvas !== null && canvas !== page.oldCanvas && view.isPageRenderFinished(parseInt(page.pageNumber, 10) - 1);
	};

	const startedAt = Date.now();
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
		// Once the primary (most visible) page is live, the new document is
		// rendering: any captured page whose page element no longer exists has
		// been virtualized off-screen and will never re-render -- don't hold its
		// snapshot (this is what previously kept the curtain up for seconds on
		// large documents).
		if (primary.done) {
			for (const page of captured) {
				if (!page.done && !view.containerEl.querySelector(`div.page[data-page-number="${page.pageNumber}"]`)) {
					releaseOne(page);
				}
			}
		}
		if (!released) timer = win.setTimeout(poll, POLL_INTERVAL_MS);
	};
	timer = win.setTimeout(poll, POLL_INTERVAL_MS);

	return { cancel: releaseAll };
}
