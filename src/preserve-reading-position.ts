// Obsidian reloads the whole PDF view whenever the file changes on disk, and on
// some documents that reload does not restore where the reader was -- it lands
// back on page 1. Measured live: highlighting on page 4 of a 7-page PDF left the
// viewer at `currentPageNumber === 1` with pages 3-7 unrendered.
//
// That is bad on its own (you lose your place every time you highlight), and it
// used to be expensive too: the reload curtain waits for the pages it snapshotted
// to come back, and pages the reload abandoned never do, so every write burned
// the curtain's full 4s failsafe. reload-curtain.ts no longer depends on any
// particular page returning, but the reading position still has to be put back,
// and that is what this module does.
import type { App } from 'obsidian';
import { getAllPdfViews, type ActivePdfView } from './obsidian-pdf-internals';

export interface ReadingPosition {
	/** Stop trying to restore (the write failed, so no reload is coming). */
	cancel(): void;
}

const POLL_INTERVAL_MS = 50;
// The reload lands within ~200ms of the write, but it can reset the position
// more than once as it settles -- a single restore fired at the first reset is
// undone by the next one, which is exactly what "it still jumps to page 1"
// looked like. So keep watching for the whole window rather than stopping at
// the first success.
const WATCH_MS = 2000;

/** Capture the reading position before a write and put it back if Obsidian's
 * reload drops it. Returns null when there's nothing to protect (position
 * unreadable, or the reader is already on page 1 -- which is where a dropped
 * position lands anyway, so there is nothing to tell apart). */
export function preserveReadingPosition(app: App, pdfView: ActivePdfView): ReadingPosition | null {
	const file = pdfView.file;
	const win = pdfView.containerEl.ownerDocument.defaultView ?? window;

	let page = 0;
	try {
		page = pdfView.getCurrentPageNumber();
	} catch {
		return null; // internals changed; the highlight itself still matters more
	}
	if (page <= 1) return null;

	// Page number alone would land the reader at the top of their page; the
	// scroller's offset puts them back exactly where they were. The document
	// re-renders at the same zoom and page sizes, so the offset stays valid.
	const scroller = findScroller(pdfView);
	const scrollTop = scroller?.scrollTop ?? 0;

	let done = false;
	let timer = 0;
	const stop = () => {
		done = true;
		win.clearTimeout(timer);
	};

	const startedAt = Date.now();
	const poll = () => {
		if (done) return;
		if (Date.now() - startedAt > WATCH_MS) return stop();

		let view: ActivePdfView | null = null;
		try {
			// Resolve by file rather than by "active view": the popup click that
			// starts a write can move focus, and getActivePdfView would then fall
			// back to whichever PDF leaf happens to be first -- a different file,
			// whose position we must not touch.
			view = getAllPdfViews(app).find((v) => v.file === file) ?? null;
		} catch {
			return stop();
		}
		if (!view) return stop(); // the file's view closed

		// Only page 1 counts as "the reload dropped the position". A reader who
		// scrolls a little during the window is left alone -- the reset always
		// lands at the very top, so it can't be confused with an ordinary scroll.
		// pagesCount is 0 until the reloaded document is laid out, which also keeps
		// us from scrolling a viewer that can't accept it yet.
		if (view.getPageCount() >= page && view.getCurrentPageNumber() === 1) {
			view.goToPage(page);
			const s = findScroller(view);
			if (s && scrollTop > 0) s.scrollTop = scrollTop;
		}
		timer = win.setTimeout(poll, POLL_INTERVAL_MS);
	};
	timer = win.setTimeout(poll, POLL_INTERVAL_MS);

	return { cancel: stop };
}

/** The element that actually scrolls the pages -- the nearest scrollable
 * ancestor of a rendered page. Found by measurement rather than by class name,
 * so an Obsidian markup change degrades to page-level restore instead of
 * throwing. */
function findScroller(view: ActivePdfView): HTMLElement | null {
	let el: HTMLElement | null = view.containerEl.querySelector<HTMLElement>('div.page[data-page-number]');
	while (el && el !== view.containerEl.parentElement) {
		if (el.scrollHeight > el.clientHeight + 1) return el;
		el = el.parentElement;
	}
	return null;
}
