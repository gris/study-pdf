import { Notice, Platform, Plugin, setIcon, setTooltip } from 'obsidian';
import {
	getActivePdfView,
	getAllPdfViews,
	patchNativeAnnotationPopup,
	type ActivePdfView,
} from './obsidian-pdf-internals';
import { showIconPopup, showNoteEditorPopup, type IconPopup, type PopupButton } from './ui/icon-popup';
import { showReloadCurtain, type CurtainPaint } from './ui/reload-curtain';
import { createSelectionOverlay, type SelectionOverlay } from './ui/selection-overlay';
import { classifyPointerGesture } from './tap-gesture';
import { shouldReplacePendingUpdate, type SelectionUpdateMode } from './selection-scheduler';
import { HighlightListModal } from './ui/highlights-modal';
import {
	clientRectToPageLocal,
	domRectToPdfBox,
	selectionRectsToQuadPoints,
	HIGHLIGHT_EXPAND_TOP,
	HIGHLIGHT_EXPAND_BOTTOM,
	type PageLocalRect,
	type PdfBox,
	pointWithinRects,
	type PdfViewportLike,
} from './geometry';
import {
	addHighlightAnnotation,
	removeHighlightsAt,
	buildHighlightIndex,
	findHighlightInIndex,
	setHighlightNoteAt,
	type HighlightIndex,
	type RgbColor,
} from './annotate';
import { normalizeQuote } from './pdf-text-extraction';
import {
	DEFAULT_SETTINGS,
	PdfHighlighterSettingTab,
	getDefaultColor,
	hexToRgbColor,
	type PdfHighlighterSettings,
} from './settings';

/** How far from the selection a touch may land and still count as "on" it --
 * covers the leading between line boxes and releasing a drag a hair past the
 * last glyph. */
const SELECTION_HIT_SLOP_PX = 6;

interface SelectionContext {
	pdfView: ActivePdfView;
	pageIndex: number;
	pageLocalRects: PageLocalRect[];
	viewport: PdfViewportLike;
	/** The exact selected text, captured while the DOM selection is still live
	 * -- stored with the highlight so the list/copy features can show precisely
	 * what was highlighted instead of reconstructing it from PDF geometry (see
	 * pdf-text-extraction.ts's extractQuote for why that's only a fallback). */
	text: string;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	// .buffer alone could include extra bytes if the array were a view over a
	// larger buffer; slice to exactly what pdf-lib actually returned.
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export default class PdfHighlighterPlugin extends Plugin {
	settings: PdfHighlighterSettings = DEFAULT_SETTINGS;
	/** Last press position inside a rendered PDF page (mousedown, or pointerdown
	 * for touch/pen -- see the pointerdown listener). Used both by "Remove
	 * highlight at selection" and the click-to-remove menu, instead of
	 * window.getSelection(): clicking directly on an existing highlight is
	 * consumed by PDF.js's own annotation layer (it shows its own popup,
	 * confirmed live) before a text selection ever forms there, so we track raw
	 * click coordinates ourselves instead. */
	private lastPdfClick: { pageIndex: number; clientX: number; clientY: number } | null = null;

	/** Tracks whichever of our popups is currently open, so a scroll or a click
	 * elsewhere can close it and so we never show two at once. */
	private activePopup: IconPopup | null = null;

	/** Shared debounce for both the mouseup/pointerup-triggered check and the
	 * selectionchange-triggered one (see the 'selectionchange' listener in
	 * onload), so a normal desktop drag-then-release coalesces into the single
	 * immediate mouseup call instead of an extra rebuild ~200ms later. Later
	 * callers generally win, except that a 'full' can't be downgraded -- see
	 * scheduleSelectionUpdate. */
	private selectionUpdateTimer = 0;

	/** Which check that timer is currently armed for, so a late low-priority one
	 * can be refused rather than silently replacing it. */
	private pendingUpdateMode: SelectionUpdateMode | null = null;

	/** Non-null only on iOS, where WKWebView ignores every ::selection property
	 * in the PDF text layer and paints a barely-visible system tint instead, so
	 * the selection has to be drawn as real elements (see selection-overlay.ts).
	 * Everywhere else ::selection works and this stays null -- painting both
	 * would double-tint the selection. */
	private selectionOverlay: SelectionOverlay | null = null;

	/** Where and when the current touch/pen press started, so a `pointercancel`
	 * can be judged as a tap or a gesture (see the pointercancel listener). */
	private pendingPress: { x: number; y: number; at: number } | null = null;

	/** Pointer ids currently down. A pinch is two of them, and each one still
	 * ends with its own pointerup -- without this every zoom gesture would be
	 * read as a tap and trigger a full check, which re-reads and re-parses the
	 * whole PDF. On a large document that is a long main-thread block landing
	 * exactly while pdf.js is re-rasterising and re-anchoring scroll position. */
	private activePointers = new Set<number>();

	/** Latched once a second finger lands, and only released when every finger
	 * is up: the tail of a pinch must not be treated as a tap either. */
	private isMultiTouchGesture = false;

	/** Where the last touch/pen press landed, in viewport coordinates. Unlike
	 * lastPdfClick this is kept even for presses outside the pages -- tapping the
	 * grey margin is still the user saying "dismiss this".
	 *
	 * One-shot: consumed by the next 'full' check and cleared. A point left lying
	 * around outlives the gesture that produced it and would later be read as a
	 * press outside some unrelated selection, silently throwing that one away.
	 *
	 * Set from pointerdown when there is one, and otherwise from pointerup --
	 * while a native iOS selection is up, WKWebView swallows the pointerdown of a
	 * tap and delivers only the pointerup (confirmed from an on-device log), so
	 * insisting on pointerdown means the dismissing tap is never measured at all.
	 * pointerdown still wins where both arrive: a long-press that creates a
	 * selection releases well away from where it started, and the release point
	 * can fall outside the very selection it just made. */
	private lastTouchPressPoint: { x: number; y: number } | null = null;

	/** Parsed highlight positions for one file version, so tapping around a
	 * document doesn't re-read and re-parse the whole PDF on every tap -- a real
	 * stall on a large one, right on the touch path.
	 *
	 * Keyed by path + mtime + size, so any edit (ours or another app's) misses
	 * and re-reads. Only ever feeds the passive "is there a highlight here?"
	 * lookup; every mutation still reads the file fresh, since a stale index
	 * there could write against bytes that no longer exist. */
	private highlightIndex: { key: string; index: HighlightIndex } | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new PdfHighlighterSettingTab(this.app, this, this));

		// Keep Obsidian's own annotation popup from overlapping our click-to-remove
		// menu (see patchNativeAnnotationPopup). Patching needs an existing PDF view
		// to reach the prototype through, so retry on layout changes until one shows up.
		let unpatchNativePopup: (() => void) | null = null;
		const tryPatchNativePopup = () => {
			if (!unpatchNativePopup) unpatchNativePopup = patchNativeAnnotationPopup(this.app);
		};
		this.app.workspace.onLayoutReady(tryPatchNativePopup);
		this.registerEvent(this.app.workspace.on('layout-change', tryPatchNativePopup));
		this.register(() => unpatchNativePopup?.());

		// A ribbon icon would show up globally (even with a .txt file open); a
		// button in the PDF view's own toolbar only appears while viewing a PDF.
		// New PDF tabs need this re-run, hence the same layout-change hook.
		this.app.workspace.onLayoutReady(() => this.ensureToolbarButtons());
		this.registerEvent(this.app.workspace.on('layout-change', () => this.ensureToolbarButtons()));

		this.registerDomEvent(document, 'mousedown', (evt) => {
			// A mouse press means we are not mid-touch; drop any remembered touch
			// point so it can't be read as "this click landed outside the selection".
			this.lastTouchPressPoint = null;
			this.recordPdfPress(evt);
		});

		this.registerDomEvent(document, 'mouseup', (evt) => {
			// Interacting with the popup itself must not re-run the show/hide logic,
			// or the popup would vanish before its button's click event fires.
			if (this.isInsideActivePopup(evt.target)) return;
			// A selection isn't final the instant mouseup fires in every browser;
			// yielding a tick first avoids reading a stale/incomplete selection.
			this.scheduleSelectionUpdate(0, 'full');
		});

		// Touch taps reach the two listeners above only as *compatibility* mouse
		// events, which the engine synthesizes after touchend and suppresses
		// whenever it decides the gesture wasn't a clean tap -- a few pixels of
		// thumb travel, a long-press promoted to a selection gesture, or a
		// preventDefault anywhere in the touch sequence is enough. That is why
		// tapping a highlight on a phone shows the note/trash popup only
		// sometimes. Pointer events are dispatched for the real gesture rather
		// than reconstructed from it, so they don't have that failure mode.
		//
		// Additive on purpose: mouse input keeps flowing through mousedown/mouseup
		// (the desktop drag-selection path those feed is load-bearing -- see the
		// selectionchange comment below), and only non-mouse pointers are handled
		// here. A tap that *does* also produce compatibility mouse events just
		// re-runs the same 'full' check, which last-wins onto one timer and
		// re-shows the same popup rather than stacking a second one.
		this.registerDomEvent(document, 'pointerdown', (evt) => {
			if (evt.pointerType === 'mouse') return;
			this.activePointers.add(evt.pointerId);
			if (this.activePointers.size > 1) {
				this.isMultiTouchGesture = true;
				this.pendingPress = null;
				return;
			}
			this.pendingPress = { x: evt.clientX, y: evt.clientY, at: performance.now() };
			if (!this.isInsideActivePopup(evt.target)) {
				this.lastTouchPressPoint = { x: evt.clientX, y: evt.clientY };
			}
			this.recordPdfPress(evt);
		});

		this.registerDomEvent(document, 'pointerup', (evt) => {
			if (evt.pointerType === 'mouse') return;
			this.pendingPress = null;
			if (this.releasePointer(evt.pointerId)) return;
			if (this.isInsideActivePopup(evt.target)) return;
			// ??=, not =: keep the pointerdown point when one arrived.
			this.lastTouchPressPoint ??= { x: evt.clientX, y: evt.clientY };
			// A tap with no pointerdown never reached recordPdfPress either, so the
			// remove-menu check below has no idea where it landed. Record it now.
			if (this.lastPdfClick === null) this.recordPdfPress(evt);
			// A real pointerup already means nothing took the gesture over, so no
			// classification is needed here -- unlike pointercancel below.
			this.scheduleSelectionUpdate(0, 'full');
		});

		// pointercancel is not "the user gave up". iOS fires it instead of
		// pointerup whenever the compositor might want the gesture, which inside a
		// scrollable PDF is most touches -- frequently after a pixel or two of
		// thumb travel, with no scroll ever happening. Dropping all of them (the
		// obvious reading) is why tapping a highlight still only worked sometimes
		// after the pointerup fix; honouring all of them would turn every scroll
		// and long-press into a tap. So a cancelled touch is judged on what it
		// actually did -- see tap-gesture.ts.
		this.registerDomEvent(document, 'pointercancel', (evt) => {
			if (evt.pointerType === 'mouse') return;
			const press = this.pendingPress;
			this.pendingPress = null;
			if (this.releasePointer(evt.pointerId)) return;
			if (!press || this.isInsideActivePopup(evt.target)) return;

			const verdict = classifyPointerGesture({
				downX: press.x,
				downY: press.y,
				endX: evt.clientX,
				endY: evt.clientY,
				durationMs: performance.now() - press.at,
			});
			if (verdict !== 'tap') return;
			this.lastTouchPressPoint ??= { x: evt.clientX, y: evt.clientY };
			this.scheduleSelectionUpdate(0, 'full');
		});
		// Dismisses the popup once the page scrolls away underneath it -- except
		// while focus is inside the popup itself (the note editor's textarea).
		// On mobile, focusing that textarea makes the OS scroll the page to lift
		// it above the on-screen keyboard, firing a real 'scroll' event that's
		// otherwise indistinguishable from the user scrolling the PDF away; without
		// this guard the note editor closed itself the instant it was focused.
		this.registerDomEvent(
			document,
			'scroll',
			() => {
				// The overlay is positioned in viewport coordinates, so it has to
				// follow the page even when the popup is being left alone.
				this.refreshSelectionOverlay();
				if (this.isInsideActivePopup(document.activeElement)) return;
				this.hideActiveMenu();
			},
			true,
		);

		// A touch text selection is made by long-pressing then dragging the
		// native selection handles -- on touchscreens that handle drag is a
		// native OS/WebView gesture that never dispatches a page-level mouseup,
		// so the mouseup listener above alone would only ever show the popup for
		// whatever got selected on the initial long-press. `selectionchange`
		// fires for every adjustment regardless of how the selection changed
		// (mouse drag included), so debouncing off it keeps the popup in sync
		// with the selection as it's extended. Not mobile-only: this also runs
		// (and gets exercised) during an ordinary desktop mouse-drag.
		if (Platform.isIosApp) {
			this.selectionOverlay = createSelectionOverlay(document);
			this.register(() => {
				this.selectionOverlay?.destroy();
				this.selectionOverlay = null;
			});
		}

		this.registerDomEvent(document, 'selectionchange', () => {
			// Repainted immediately rather than on the 200ms debounce below: this
			// is what the user watches while dragging the selection handles, and
			// a fifth of a second of lag behind their thumb is very visible.
			this.refreshSelectionOverlay();
			this.scheduleSelectionUpdate(200, 'selection-only');
		});
		this.register(() => {
			window.clearTimeout(this.selectionUpdateTimer);
			this.pendingUpdateMode = null;
		});

		this.addCommand({
			id: 'highlight-selection',
			name: 'Highlight selection',
			checkCallback: (checking) => {
				if (!getActivePdfView(this.app)) return false;
				if (!checking) {
					const color = getDefaultColor(this.settings);
					void this.highlightCurrentSelection(hexToRgbColor(color.hex));
				}
				return true;
			},
		});

		this.addCommand({
			id: 'list-highlights',
			name: 'Show all highlights and notes',
			checkCallback: (checking) => {
				const pdfView = getActivePdfView(this.app);
				if (!pdfView) return false;
				if (!checking) new HighlightListModal(this.app, pdfView).open();
				return true;
			},
		});

		this.addCommand({
			id: 'remove-highlight-at-selection',
			name: 'Remove highlight at selection',
			checkCallback: (checking) => {
				if (!getActivePdfView(this.app)) return false;
				if (!checking) void this.removeHighlightAtLastClick();
				return true;
			},
		});

	}

	onunload() {
		this.hideActiveMenu();
	}

	async loadSettings() {
		// loadData() is genuinely `any` (Obsidian has no way to know a plugin's
		// settings shape); an explicit cast, not a type annotation, is what
		// actually tells the type checker this any is intentional here.
		const loaded = (await this.loadData()) as Partial<PdfHighlighterSettings> | null;
		// The palette is fully fixed: always use the built-in colors, ignoring any
		// hexes saved by older plugin versions (the UI no longer edits them, and
		// this lets palette upgrades actually reach existing installs). Copied
		// (not reused) so nothing ever mutates the DEFAULT_SETTINGS constant.
		const colors = DEFAULT_SETTINGS.colors.map((c) => ({ ...c }));
		this.settings = { ...DEFAULT_SETTINGS, ...loaded, colors };
		if (!colors.some((c) => c.name === this.settings.defaultColorName)) {
			this.settings.defaultColorName = DEFAULT_SETTINGS.defaultColorName;
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Adds our "show highlights" button to every open PDF view's own toolbar
	 * (the bar with zoom/page controls) that doesn't already have one. Runs on
	 * layout changes since new PDF tabs need it added, and re-running on tabs
	 * that already have it is a no-op -- checked against the live DOM (a marker
	 * class on the button), not an in-memory set: a PDF view's toolbar persists
	 * not just across file reloads but across a *plugin* reload too (confirmed
	 * reading Obsidian's shipped app.js: only the inner pdf.js viewer is torn
	 * down on file reload, and a plugin reload doesn't touch the view at all),
	 * while an in-memory set would reset to empty on every plugin reload and
	 * duplicate the button on every one after the first. */
	private ensureToolbarButtons() {
		for (const pdfView of getAllPdfViews(this.app)) {
			const toolbarRight = pdfView.getToolbarRightElement();
			if (!toolbarRight || toolbarRight.querySelector(':scope > .study-pdf-toolbar-button')) continue;

			const button = toolbarRight.createDiv('clickable-icon study-pdf-toolbar-button');
			setIcon(button, 'list-checks');
			setTooltip(button, 'Show all highlights and notes');
			button.addEventListener('click', () => new HighlightListModal(this.app, pdfView).open());
		}
	}

	private isInsideActivePopup(target: EventTarget | null): boolean {
		return target instanceof Node && this.activePopup !== null && this.activePopup.el.contains(target);
	}

	private hideActiveMenu() {
		this.activePopup?.hide();
		this.activePopup = null;
	}

	private showPopup(
		doc: Document,
		position: { x: number; y: number },
		buttons: PopupButton[],
		options: { text?: string } = {},
	) {
		this.hideActiveMenu();
		this.activePopup = showIconPopup(doc, position, buttons, options);
	}

	/** Silent version of the selection lookup: no Notices, since this runs on
	 * every mouseup across all of Obsidian (to decide whether to show a menu) --
	 * most of those clicks have nothing to do with a PDF selection at all, and
	 * popping error notices for that would be spammy. */
	private trySelectionContext(): SelectionContext | null {
		const pdfView = getActivePdfView(this.app);
		if (!pdfView) return null;

		const selection = window.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
		const range = selection.getRangeAt(0);

		const pageIndex = pdfView.findPageIndexForNode(range.commonAncestorContainer);
		if (pageIndex === null) return null;

		const pageEl = pdfView.getPageElement(pageIndex);
		if (!pageEl) return null;
		const pageOrigin = pageEl.getBoundingClientRect();

		const clientRects = Array.from(range.getClientRects());
		if (clientRects.length === 0) return null;
		const pageLocalRects: PageLocalRect[] = clientRects.map((r) => clientRectToPageLocal(r, pageOrigin));
		const viewport = pdfView.getPageViewport(pageIndex);

		return { pdfView, pageIndex, pageLocalRects, viewport, text: selection.toString() };
	}

	/** Same lookup, but explains itself with a Notice on failure -- for the
	 * explicit "Highlight selection" command, where silent failure would be
	 * confusing (the user just ran a command and nothing happened). */
	private getSelectionContextOrNotify(): SelectionContext | null {
		if (!getActivePdfView(this.app)) {
			new Notice('Study PDF: no PDF is open in the active pane.');
			return null;
		}
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
			new Notice('Study PDF: select some text in the PDF first.');
			return null;
		}
		const ctx = this.trySelectionContext();
		if (!ctx) {
			new Notice('Study PDF: could not read the current selection.');
			return null;
		}
		return ctx;
	}

	/** Coalesces the mouseup-triggered ('full') and selectionchange-triggered
	 * ('selection-only') checks onto one timer -- see selectionUpdateTimer's
	 * doc comment. */
	private scheduleSelectionUpdate(delayMs: number, mode: SelectionUpdateMode) {
		// Not simply last-wins: a late 'selection-only' must not cancel a pending
		// 'full', or the popup can never be dismissed. See selection-scheduler.ts.
		if (!shouldReplacePendingUpdate(this.pendingUpdateMode, mode)) return;

		window.clearTimeout(this.selectionUpdateTimer);
		this.pendingUpdateMode = mode;
		this.selectionUpdateTimer = window.setTimeout(() => {
			this.pendingUpdateMode = null;
			if (mode === 'full') void this.updateSelectionMenu();
			else this.updateSelectionPopupForLiveSelection();
		}, delayMs);
	}

	/** Shows/refreshes the "add highlight" color-dot popup for whatever the
	 * current text selection is, or does nothing if the selection is collapsed
	 * (e.g. it just got cleared by performHighlight). Used by the
	 * selectionchange path, which -- unlike a mouseup -- can't tell whether "no
	 * selection" means "check for a highlight to remove instead": a selection
	 * merely collapsing isn't the same user action as a deliberate click. */
	/** Records where a press landed inside a rendered PDF page, and — just as
	 * importantly — forgets the previous one when it landed anywhere else.
	 *
	 * Without the forgetting, pressing outside the pages (the grey margin, the
	 * toolbar, another pane) leaves a stale `lastPdfClick` pointing at whatever
	 * highlight was pressed before, so the follow-up check hides the popup and
	 * then immediately re-shows the identical popup in the identical place. To
	 * the user the popup simply refuses to dismiss.
	 *
	 * Presses inside our own popup are exempt: its buttons act on that remembered
	 * click, so tapping "remove" must not erase the thing it is about to remove. */
	private recordPdfPress(evt: MouseEvent | PointerEvent) {
		if (this.isInsideActivePopup(evt.target)) return;

		const pdfView = getActivePdfView(this.app);
		const pageIndex =
			pdfView && evt.target instanceof Node ? pdfView.findPageIndexForNode(evt.target) : null;
		if (pageIndex === null) {
			this.lastPdfClick = null;
			return;
		}
		this.lastPdfClick = { pageIndex, clientX: evt.clientX, clientY: evt.clientY };
	}

	/** The highlight index for the current file version, reading and parsing the
	 * PDF only when the cached one is for a different version. */
	private async getHighlightIndex(pdfView: ActivePdfView): Promise<HighlightIndex> {
		const file = pdfView.file;
		const key = `${file.path}:${file.stat.mtime}:${file.stat.size}`;
		if (this.highlightIndex?.key === key) return this.highlightIndex.index;

		const bytes = await this.app.vault.readBinary(file);
		const index = await buildHighlightIndex(new Uint8Array(bytes));
		this.highlightIndex = { key, index };
		return index;
	}

	/** Drops the cached index after our own writes. The mtime+size key would
	 * usually catch these anyway, but two saves inside the same millisecond that
	 * happen to land on the same size would not -- and the cost of being wrong
	 * here is a popup that lies about what is in the file. */
	private invalidateHighlightIndex() {
		this.highlightIndex = null;
	}

	/** Books a pointer as lifted. Returns true when this event belongs to a
	 * multi-touch gesture and must not be treated as a tap.
	 *
	 * Note the ids are dropped defensively: iOS swallows the pointerdown of a tap
	 * while a selection is up (see the pointerdown listener), so an id can be
	 * absent here without anything being wrong. */
	private releasePointer(pointerId: number): boolean {
		this.activePointers.delete(pointerId);
		if (!this.isMultiTouchGesture) return false;
		// Stay latched until the last finger leaves, then swallow this one too.
		if (this.activePointers.size === 0) this.isMultiTouchGesture = false;
		return true;
	}

	/** True when the last touch/pen press landed away from the given selection.
	 *
	 * Mouse presses never qualify: desktop collapses a selection on click by
	 * itself, so that path already works and has no reason to enter this logic.
	 * A press *inside* the selection is how a long-press that just created one
	 * arrives here — treating that as "tapped away" would throw away the
	 * selection the moment the user made it. */
	private touchPressLandedOutside(selectionCtx: SelectionContext): boolean {
		const press = this.lastTouchPressPoint;
		if (!press) return false;

		const range = window.getSelection()?.getRangeAt(0);
		if (!range) return false;
		const rects = Array.from(range.getClientRects()).map((r) => ({
			left: r.left,
			top: r.top,
			right: r.right,
			bottom: r.bottom,
		}));
		const inside = pointWithinRects(press, rects, SELECTION_HIT_SLOP_PX);
		return rects.length > 0 && !inside;
	}

	/** Repaints (or clears) the iOS selection overlay. No-op on every other
	 * platform, where selectionOverlay is null and ::selection does the job. */
	private refreshSelectionOverlay() {
		const overlay = this.selectionOverlay;
		if (!overlay) return;

		const selection = window.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
			overlay.update([]);
			return;
		}
		const range = selection.getRangeAt(0);

		// Selections elsewhere in Obsidian (a note in a split, the file list) must
		// not get painted over -- ::selection already handles those correctly.
		const pdfView = getActivePdfView(this.app);
		if (!pdfView || pdfView.findPageIndexForNode(range.commonAncestorContainer) === null) {
			overlay.update([]);
			return;
		}

		overlay.update(
			Array.from(range.getClientRects()).map((r) => ({
				left: r.left,
				top: r.top,
				width: r.width,
				height: r.height,
			})),
		);
	}

	private updateSelectionPopupForLiveSelection() {
		const selectionCtx = this.trySelectionContext();
		if (selectionCtx) this.showAddHighlightPopup(selectionCtx);
	}

	private showAddHighlightPopup(selectionCtx: SelectionContext) {
		const range = window.getSelection()!.getRangeAt(0); // trySelectionContext just confirmed this exists
		const rect = range.getBoundingClientRect();
		const doc = selectionCtx.pdfView.containerEl.ownerDocument;

		// Default color first: it's the most likely pick, so it gets the spot
		// closest to where the cursor already is.
		const colors = [...this.settings.colors].sort(
			(a, b) =>
				Number(b.name === this.settings.defaultColorName) - Number(a.name === this.settings.defaultColorName),
		);
		const buttons: PopupButton[] = colors.map((color) => ({
			type: 'color',
			hex: color.hex,
			name: color.name,
			onClick: () => void this.performHighlight(selectionCtx, hexToRgbColor(color.hex)),
		}));
		this.showPopup(doc, { x: rect.left, y: rect.bottom + 4 }, buttons);
	}

	/** Runs on every mouseup: shows the "add highlight" color-dot popup for a
	 * real text selection, or (if there's no selection but a highlight exists
	 * right where the user just clicked) the trash-icon "remove" popup instead. */
	private async updateSelectionMenu() {
		// Unconditional: if a selectionchange ever fails to arrive, this is the
		// only place that notices the painted overlay no longer matches reality.
		this.refreshSelectionOverlay();

		const selectionCtx = this.trySelectionContext();
		const pressLandedOutside = selectionCtx !== null && this.touchPressLandedOutside(selectionCtx);
		this.lastTouchPressPoint = null; // one-shot, see the field's doc comment
		if (selectionCtx && pressLandedOutside) {
			// iOS keeps a selection alive when you tap away from it, so "there is
			// still a selection" is not evidence the user still wants one. Drop it
			// ourselves and carry on into the remove-menu check below, exactly as
			// if the press had found no selection.
			window.getSelection()?.removeAllRanges();
			this.refreshSelectionOverlay();
			this.hideActiveMenu();
			await this.maybeShowRemoveMenu();
			return;
		}
		if (selectionCtx) {
			this.showAddHighlightPopup(selectionCtx);
			return;
		}

		this.hideActiveMenu();
		await this.maybeShowRemoveMenu();
	}

	/** Resolves a raw click (page index + client coords) into a PDF-space box,
	 * or null with a Notice explaining why (when `notify` is set) -- shared by
	 * the explicit remove command and the passive click-to-remove menu check. */
	private resolveClickBox(
		pdfView: ActivePdfView,
		click: { pageIndex: number; clientX: number; clientY: number },
		notify: boolean,
	): { pageIndex: number; box: PdfBox } | null {
		const pageEl = pdfView.getPageElement(click.pageIndex);
		if (!pageEl) {
			if (notify) new Notice('Study PDF: that page is not currently rendered.');
			return null;
		}
		const pageOrigin = pageEl.getBoundingClientRect();
		const pageLocalPoint = clientRectToPageLocal(
			{ left: click.clientX, top: click.clientY, right: click.clientX, bottom: click.clientY },
			pageOrigin,
		);
		const viewport = pdfView.getPageViewport(click.pageIndex);
		return { pageIndex: click.pageIndex, box: domRectToPdfBox(pageLocalPoint, viewport) };
	}

	private async maybeShowRemoveMenu() {
		const pdfView = getActivePdfView(this.app);
		const click = this.lastPdfClick;
		if (!pdfView || !click) return;

		const resolved = this.resolveClickBox(pdfView, click, false);
		if (!resolved) return;

		try {
			const info = findHighlightInIndex(await this.getHighlightIndex(pdfView), resolved);
			// The user may have clicked/selected something else while this async
			// check was running -- only show the menu if that click is still current.
			if (!info || this.lastPdfClick !== click) return;

			const doc = pdfView.containerEl.ownerDocument;
			const position = { x: click.clientX, y: click.clientY + 4 };
			this.showPopup(
				doc,
				position,
				[
					{
						type: 'icon',
						icon: 'sticky-note',
						label: info.note ? 'Edit note' : 'Add note',
						onClick: () => {
							this.hideActiveMenu();
							this.activePopup = showNoteEditorPopup(doc, position, {
								initial: info.note ?? '',
								onSave: (note) => {
									this.hideActiveMenu();
									void this.performSetNote(resolved, note);
								},
								onCancel: () => this.hideActiveMenu(),
							});
						},
					},
					{
						type: 'icon',
						icon: 'trash-2',
						label: 'Remove highlight',
						onClick: () => {
							this.hideActiveMenu();
							void this.performRemove(resolved);
						},
					},
				],
				// Show the existing note right in the popup -- the native Obsidian
				// annotation popup that used to display it is suppressed for
				// highlights (see patchNativeAnnotationPopup).
				{ text: info.note ?? undefined },
			);
		} catch {
			// Silent: this is a passive background check, not an explicit user action.
		}
	}

	private async highlightCurrentSelection(color: RgbColor) {
		const ctx = this.getSelectionContextOrNotify();
		if (!ctx) return;
		await this.performHighlight(ctx, color);
	}

	private async performHighlight(ctx: SelectionContext, color: RgbColor) {
		const { pdfView, pageIndex, pageLocalRects, viewport, text } = ctx;
		const { quadPoints, box } = selectionRectsToQuadPoints(
			pageLocalRects,
			viewport,
			HIGHLIGHT_EXPAND_TOP,
			HIGHLIGHT_EXPAND_BOTTOM,
		);

		// Raise the curtain BEFORE any PDF work, with the new highlight painted
		// into the page snapshot: the result is visible instantly, and the write
		// plus Obsidian's full view reload happen invisibly underneath. If the
		// write fails, the curtain is cancelled and the painted preview vanishes
		// with it -- accurate feedback either way.
		const origin = pdfView.getPageElement(pageIndex)?.getBoundingClientRect();
		const paint: CurtainPaint | undefined = origin && {
			pageNumber: String(pageIndex + 1),
			// Mirror the vertical adjustment the real annotation gets, so the
			// painted preview and the final render line up when the curtain lifts.
			// (Client y grows downward, so a positive top-expand moves the top UP.)
			rects: pageLocalRects.map((r) => {
				const h = r.bottom - r.top;
				return {
					left: r.left + origin.left,
					top: r.top + origin.top - h * HIGHLIGHT_EXPAND_TOP,
					width: r.right - r.left,
					height: h * (1 + HIGHLIGHT_EXPAND_TOP + HIGHLIGHT_EXPAND_BOTTOM),
				};
			}),
			color: `rgb(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)})`,
			opacity: 1,
		} || undefined;
		const curtain = showReloadCurtain(this.app, pdfView, paint);
		window.getSelection()?.removeAllRanges();
		this.hideActiveMenu();

		try {
			const existingBytes = await this.app.vault.readBinary(pdfView.file);
			const highlighted = await addHighlightAnnotation(new Uint8Array(existingBytes), {
				pageIndex,
				quadPoints,
				box,
				color,
				quote: normalizeQuote(text),
			});
			// Obsidian auto-reloads the PDF view on file modification (confirmed
			// live) -- no explicit refresh needed; the curtain masks its flicker.
			this.invalidateHighlightIndex();
			await this.app.vault.modifyBinary(pdfView.file, toArrayBuffer(highlighted));
		} catch (err) {
			curtain?.cancel();
			console.error('Study PDF: failed to add highlight', err);
			new Notice(`Study PDF: failed to add highlight -- ${(err as Error).message}`, 0);
		}
	}

	/** Explicit "Remove highlight at selection" command: uses the last click,
	 * same as the menu, but explains itself with a Notice on failure. */
	private async removeHighlightAtLastClick() {
		const pdfView = getActivePdfView(this.app);
		if (!pdfView) {
			new Notice('Study PDF: no PDF is open in the active pane.');
			return;
		}
		const click = this.lastPdfClick;
		if (!click) {
			new Notice('Study PDF: click on a highlight first.');
			return;
		}
		const resolved = this.resolveClickBox(pdfView, click, true);
		if (!resolved) return;
		await this.performRemove(resolved);
	}

	/** Writes the note into the highlight's /Contents. A note edit doesn't change
	 * how the page renders, but the file write still triggers Obsidian's full
	 * view reload -- so it gets the same curtain treatment as everything else. */
	private async performSetNote({ pageIndex, box }: { pageIndex: number; box: PdfBox }, note: string) {
		const pdfView = getActivePdfView(this.app);
		if (!pdfView) return;

		const curtain = showReloadCurtain(this.app, pdfView);
		try {
			const existingBytes = await this.app.vault.readBinary(pdfView.file);
			const result = await setHighlightNoteAt(new Uint8Array(existingBytes), { pageIndex, box, note });
			if (result.updatedCount === 0) {
				curtain?.cancel();
				new Notice('Study PDF: no highlight found where you clicked.');
				return;
			}
			this.invalidateHighlightIndex();
			await this.app.vault.modifyBinary(pdfView.file, toArrayBuffer(result.bytes));
		} catch (err) {
			curtain?.cancel();
			console.error('Study PDF: failed to save note', err);
			new Notice(`Study PDF: failed to save note -- ${(err as Error).message}`, 0);
		}
	}

	private async performRemove({ pageIndex, box }: { pageIndex: number; box: PdfBox }) {
		const pdfView = getActivePdfView(this.app);
		if (!pdfView) return;

		// Curtain up before the PDF work, same as performHighlight (no painted
		// preview here: the old pixels still show the highlight until the
		// reloaded, highlight-free page fades in).
		const curtain = showReloadCurtain(this.app, pdfView);
		this.hideActiveMenu();
		try {
			const existingBytes = await this.app.vault.readBinary(pdfView.file);
			const result = await removeHighlightsAt(new Uint8Array(existingBytes), { pageIndex, box });
			if (result.removedCount === 0) {
				curtain?.cancel();
				new Notice('Study PDF: no highlight found where you clicked.');
				return;
			}
			this.invalidateHighlightIndex();
			await this.app.vault.modifyBinary(pdfView.file, toArrayBuffer(result.bytes));
		} catch (err) {
			curtain?.cancel();
			console.error('Study PDF: failed to remove highlight', err);
			new Notice(`Study PDF: failed to remove highlight -- ${(err as Error).message}`, 0);
		}
	}
}
