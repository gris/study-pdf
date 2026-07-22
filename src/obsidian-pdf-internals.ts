// The ONLY module that touches undocumented Obsidian/PDF.js internals. If an
// Obsidian update breaks this, it breaks here -- one file, typed surface, loud
// failure (throws with a clear message) rather than a silent wrong-position
// highlight. The property path below was confirmed empirically against a real
// running Obsidian instance (spike script preserved in git history under spike/):
//   view.viewer.child.pdfViewer.pdfViewer  ->  the live PDF.js PDFViewer instance
// (verified: getPageView(0).viewport.scale exactly matched the DOM's
// --scale-factor, and .convertToPdfPoint exists on that viewport.)
import { FileView } from 'obsidian';
import type { App, TFile, WorkspaceLeaf } from 'obsidian';
import type { PdfViewportLike } from './geometry';

export interface ActivePdfView {
	file: TFile;
	containerEl: HTMLElement;
	/** 0-based page index. */
	getPageViewport(pageIndex: number): PdfViewportLike;
	/** 0-based page index. Returns the element whose getBoundingClientRect() gives
	 * the "page origin" for mapping a client rect to page-local coordinates, or
	 * null if that page isn't currently rendered (PDF.js virtualizes pages -- an
	 * off-screen page may not have a live element).
	 *
	 * This is the page's .textLayer div, NOT the outer .page container -- found
	 * live: the .page div has a decorative border (pdf.js viewer.css convention)
	 * that getBoundingClientRect() includes, silently offsetting every highlight
	 * by the border width. .textLayer has no border and is exactly the coordinate
	 * space text selections (and viewport.convertToPdfPoint) actually live in. */
	getPageElement(pageIndex: number): HTMLElement | null;
	/** Walks up from a DOM node to find which rendered page contains it. Returns
	 * the 0-based page index, or null if the node isn't inside any page. Used to
	 * group a (possibly multi-page) selection's client rects by page. */
	findPageIndexForNode(node: Node): number | null;
	/** True once the page's canvas is fully painted (PDF.js renderingState
	 * FINISHED). Used by the reload curtain to know when it's safe to reveal the
	 * freshly reloaded document. Errs on true if the internal field is missing,
	 * so a PDF.js update can only make the curtain lift early, never hang. */
	isPageRenderFinished(pageIndex: number): boolean;
	/** The live PDF.js PDFDocumentProxy of the open viewer. Lets features read
	 * annotations/text without re-parsing the file (and without bundling our own
	 * copy of pdf.js). */
	getPdfJsDocument(): unknown;
	/** Scrolls the viewer to the given 1-based page number. */
	goToPage(pageNumber: number): void;
	/** The (otherwise empty) right-hand section of this PDF view's own toolbar
	 * (`div.pdf-toolbar-right`, sits after the page-number field) -- confirmed
	 * from Obsidian's shipped app.js as an intentionally bare container the
	 * toolbar class creates and never populates itself, i.e. the natural slot
	 * for a plugin-added button. Returns null if that structure has changed. */
	getToolbarRightElement(): HTMLElement | null;
}

const INTERNALS_ERROR =
	'Study PDF: could not find the PDF viewer internals on this version of Obsidian. ' +
	'This plugin relies on an undocumented internal API that may have changed -- please report this issue.';

type Unsafe = any;

interface RawPdfView {
	file: TFile | null;
	containerEl: HTMLElement;
	viewer?: {
		child?: {
			renderAnnotationPopup?: unknown;
			pdfViewer?: {
				pdfViewer?: Unsafe;
			};
		};
	};
}

function getLivePdfViewer(view: RawPdfView): Unsafe {
	const pdfViewer = view.viewer?.child?.pdfViewer?.pdfViewer;
	if (!pdfViewer || typeof pdfViewer.getPageView !== 'function') {
		throw new Error(INTERNALS_ERROR);
	}
	return pdfViewer;
}

/** Obsidian's built-in PDF viewer shows its own popup (`div.popupWrapper`) when
 * an annotation is clicked -- created by `renderAnnotationPopup` on the viewer
 * child object (confirmed by reading Obsidian's shipped app.js: its
 * `onAnnotationPointerDown` handler calls it on pointerup for every non-Widget,
 * non-Link annotation). Since our own "Remove highlight" menu appears on that
 * same click, the two overlap. Event-level suppression was tried and failed
 * (the handler runs on `window` before ours, and blocking events broke our own
 * menus), so instead we patch the method itself on the shared prototype: skip
 * the native popup for /Highlight annotations -- our popup owns that
 * interaction entirely (it shows the highlight's note and the note/remove
 * actions) -- and keep it for every other annotation type (text notes, stamps).
 *
 * Returns an undo function, or null if no PDF view exists yet to patch through
 * (callers should retry on layout changes). Patching the prototype covers all
 * current and future PDF views at once. */
export function patchNativeAnnotationPopup(app: App): (() => void) | null {
	for (const leaf of app.workspace.getLeavesOfType('pdf')) {
		const child = (leaf.view as unknown as RawPdfView).viewer?.child as Unsafe;
		if (!child || typeof child.renderAnnotationPopup !== 'function') continue;

		const proto = Object.getPrototypeOf(child);
		if (typeof proto?.renderAnnotationPopup !== 'function') continue;

		const original = proto.renderAnnotationPopup;
		proto.renderAnnotationPopup = function (annotation: Unsafe) {
			if (annotation?.data?.subtype === 'Highlight') return;
			return original.call(this, annotation);
		};
		return () => {
			proto.renderAnnotationPopup = original;
		};
	}
	return null;
}

/** Builds the typed view surface for one PDF leaf, or null if it has no file
 * open yet (e.g. still loading). Shared by getActivePdfView (one leaf) and
 * getAllPdfViews (every open PDF leaf, for features like the toolbar button
 * that must apply to every PDF tab, not just the focused one). */
function buildPdfView(leaf: WorkspaceLeaf): ActivePdfView | null {
	const view = leaf.view as unknown as RawPdfView;
	const file = view.file;
	if (!file) return null;

	const pdfViewer = getLivePdfViewer(view);

	const getPageElement = (pageIndex: number): HTMLElement | null => {
		const pageEl = view.containerEl.querySelector<HTMLElement>(`div.page[data-page-number="${pageIndex + 1}"]`);
		return pageEl?.querySelector<HTMLElement>('.textLayer') ?? pageEl;
	};

	return {
		file,
		containerEl: view.containerEl,

		getPageViewport(pageIndex: number): PdfViewportLike {
			const pageView = pdfViewer.getPageView(pageIndex);
			const viewport = pageView?.viewport;
			if (!viewport || typeof viewport.convertToPdfPoint !== 'function') {
				throw new Error(INTERNALS_ERROR);
			}
			return viewport;
		},

		getPageElement,

		isPageRenderFinished(pageIndex: number): boolean {
			const pageView = pdfViewer.getPageView(pageIndex);
			if (!pageView) return false;
			// PDF.js RenderingStates.FINISHED === 3 (stable across versions).
			return typeof pageView.renderingState !== 'number' || pageView.renderingState === 3;
		},

		getPdfJsDocument(): unknown {
			const pdfDocument = pdfViewer.pdfDocument;
			if (!pdfDocument || typeof pdfDocument.getPage !== 'function') {
				throw new Error(INTERNALS_ERROR);
			}
			return pdfDocument;
		},

		goToPage(pageNumber: number): void {
			pdfViewer.currentPageNumber = pageNumber;
		},

		getToolbarRightElement(): HTMLElement | null {
			return view.containerEl.querySelector<HTMLElement>('.pdf-toolbar-right');
		},

		findPageIndexForNode(node: Node): number | null {
			// .instanceOf, not instanceof: Obsidian supports popout windows with
			// their own separate HTMLElement realm, so a plain `instanceof`
			// against the main window's class can wrongly return false for a
			// node that lives in one.
			const el = node.instanceOf(HTMLElement) ? node : node.parentElement;
			const pageEl = el?.closest('div.page[data-page-number]');
			if (!pageEl) return null;
			const pageNumber = pageEl.getAttribute('data-page-number');
			if (!pageNumber) return null;
			return parseInt(pageNumber, 10) - 1;
		},
	};
}

/** Returns the active PDF view, or null if no PDF is open (not an error --
 * callers should just no-op, e.g. disable the highlight command). Throws
 * INTERNALS_ERROR if a PDF view exists but its internal shape doesn't match what
 * we expect (loud failure, per design -- see module header).
 *
 * `workspace.activeLeaf` is deprecated; Obsidian's own doc comment on it points
 * to `getActiveViewOfType` for exactly this "what's the active view" case. PDF
 * views are a `FileView` subclass (confirmed: `getViewType()` returns 'pdf'),
 * so passing the public `FileView` base class catches the active view whenever
 * it's any kind of file view, and the getViewType() check narrows to PDF
 * specifically. Preserves the previous fallback too: if focus isn't currently
 * on a PDF tab (e.g. the sidebar has focus) but one is still open in the
 * background, fall back to the first open PDF leaf rather than returning null. */
export function getActivePdfView(app: App): ActivePdfView | null {
	const activeView = app.workspace.getActiveViewOfType(FileView);
	if (activeView && activeView.getViewType() === 'pdf') {
		return buildPdfView(activeView.leaf);
	}

	const leaves = app.workspace.getLeavesOfType('pdf');
	return leaves.length > 0 ? buildPdfView(leaves[0]!) : null;
}

/** Every currently open PDF view (one per tab/pane), regardless of focus.
 * Used to keep a toolbar button present on every open PDF, not just whichever
 * one is currently active. */
export function getAllPdfViews(app: App): ActivePdfView[] {
	const views: ActivePdfView[] = [];
	for (const leaf of app.workspace.getLeavesOfType('pdf')) {
		const view = buildPdfView(leaf);
		if (view) views.push(view);
	}
	return views;
}
