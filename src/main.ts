import { Notice, Plugin, setIcon, setTooltip } from 'obsidian';
import {
	getActivePdfView,
	getAllPdfViews,
	patchNativeAnnotationPopup,
	type ActivePdfView,
} from './obsidian-pdf-internals';
import { showIconPopup, showNoteEditorPopup, type IconPopup, type PopupButton } from './ui/icon-popup';
import { showReloadCurtain, type CurtainPaint } from './ui/reload-curtain';
import { HighlightListModal } from './ui/highlights-modal';
import {
	clientRectToPageLocal,
	domRectToPdfBox,
	selectionRectsToQuadPoints,
	HIGHLIGHT_EXPAND_TOP,
	HIGHLIGHT_EXPAND_BOTTOM,
	type PageLocalRect,
	type PdfBox,
	type PdfViewportLike,
} from './geometry';
import {
	addHighlightAnnotation,
	removeHighlightsAt,
	inspectHighlightAt,
	setHighlightNoteAt,
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
	/** Last mousedown position inside a rendered PDF page. Used both by "Remove
	 * highlight at selection" and the click-to-remove menu, instead of
	 * window.getSelection(): clicking directly on an existing highlight is
	 * consumed by PDF.js's own annotation layer (it shows its own popup,
	 * confirmed live) before a text selection ever forms there, so we track raw
	 * click coordinates ourselves instead. */
	private lastPdfClick: { pageIndex: number; clientX: number; clientY: number } | null = null;

	/** Tracks whichever of our popups is currently open, so a scroll or a click
	 * elsewhere can close it and so we never show two at once. */
	private activePopup: IconPopup | null = null;

	/** Toolbar-right elements we've already added our button to -- a PDF view's
	 * toolbar persists across file reloads (confirmed reading Obsidian's shipped
	 * app.js: only the inner pdf.js viewer is torn down on reload, not the
	 * outer toolbar), so this only needs to happen once per opened PDF tab. */
	private readonly toolbarButtonsInjected = new WeakSet<HTMLElement>();

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
			if (this.isInsideActivePopup(evt.target)) return;
			const pdfView = getActivePdfView(this.app);
			if (!pdfView || !(evt.target instanceof Node)) return;
			const pageIndex = pdfView.findPageIndexForNode(evt.target);
			if (pageIndex === null) return;
			this.lastPdfClick = { pageIndex, clientX: evt.clientX, clientY: evt.clientY };
		});

		this.registerDomEvent(document, 'mouseup', (evt) => {
			// Interacting with the popup itself must not re-run the show/hide logic,
			// or the popup would vanish before its button's click event fires.
			if (this.isInsideActivePopup(evt.target)) return;
			// A selection isn't final the instant mouseup fires in every browser;
			// yielding a tick first avoids reading a stale/incomplete selection.
			window.setTimeout(() => void this.updateSelectionMenu(), 0);
		});
		this.registerDomEvent(document, 'scroll', () => this.hideActiveMenu(), true);

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
	 * that already have it is a no-op via toolbarButtonsInjected. */
	private ensureToolbarButtons() {
		for (const pdfView of getAllPdfViews(this.app)) {
			const toolbarRight = pdfView.getToolbarRightElement();
			if (!toolbarRight || this.toolbarButtonsInjected.has(toolbarRight)) continue;
			this.toolbarButtonsInjected.add(toolbarRight);

			const button = toolbarRight.createDiv('clickable-icon');
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

	/** Runs on every mouseup: shows the "add highlight" color-dot popup for a
	 * real text selection, or (if there's no selection but a highlight exists
	 * right where the user just clicked) the trash-icon "remove" popup instead. */
	private async updateSelectionMenu() {
		const selectionCtx = this.trySelectionContext();
		if (selectionCtx) {
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
			const existingBytes = await this.app.vault.readBinary(pdfView.file);
			const info = await inspectHighlightAt(new Uint8Array(existingBytes), resolved);
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
			await this.app.vault.modifyBinary(pdfView.file, toArrayBuffer(result.bytes));
		} catch (err) {
			curtain?.cancel();
			console.error('Study PDF: failed to remove highlight', err);
			new Notice(`Study PDF: failed to remove highlight -- ${(err as Error).message}`, 0);
		}
	}
}
