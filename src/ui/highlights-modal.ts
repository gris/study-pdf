// "Show all highlights and notes": a native Obsidian Modal listing every
// /Highlight annotation in the open PDF -- color dot, the highlighted text
// (recovered by matching the annotation's QuadPoints against the page's text
// items), the note if any, and the page number. Clicking a row jumps there.
//
// Reads everything from the viewer's LIVE pdf.js document: no file re-parse,
// and no need to bundle our own copy of pdf.js.
import { Modal, Notice, setIcon, setTooltip, type App } from 'obsidian';
import type { ActivePdfView } from '../obsidian-pdf-internals';
import { quadPointsToRects, extractQuote, type PdfJsTextItem } from '../pdf-text-extraction';

interface HighlightEntry {
	pageNumber: number;
	/** PDF-space top of the first quad; used to sort entries in reading order. */
	top: number;
	colorCss: string;
	quote: string;
	note: string | null;
	/** pdf.js annotation id (e.g. "40R") -- the same id Obsidian's own
	 * `#page=N&annotation=ID` deep links target. */
	annotationId: string | null;
}

// Minimal local shapes for the slice of pdf.js's live, untyped document we
// actually read -- same approach as PdfViewportLike in geometry.ts: capture
// only what we use, rather than depending on pdfjs-dist's real (and
// version-specific) types for this glue code.
interface PdfJsAnnotation {
	subtype?: string;
	quadPoints?: unknown;
	color?: number[];
	contentsObj?: { str?: string };
	id?: string;
}

interface PdfJsPage {
	getAnnotations(): Promise<PdfJsAnnotation[]>;
	getTextContent(): Promise<{ items: PdfJsTextItem[] }>;
}

interface PdfJsDocument {
	numPages: number;
	getPage(pageNumber: number): Promise<PdfJsPage>;
}

async function collectHighlights(pdfjsDoc: PdfJsDocument): Promise<HighlightEntry[]> {
	const entries: HighlightEntry[] = [];
	for (let pageNumber = 1; pageNumber <= pdfjsDoc.numPages; pageNumber++) {
		const page = await pdfjsDoc.getPage(pageNumber);
		const annotations = await page.getAnnotations();
		const highlights = annotations.filter((a) => a.subtype === 'Highlight');
		if (highlights.length === 0) continue;

		const textContent = await page.getTextContent();
		for (const annotation of highlights) {
			const rects = quadPointsToRects(annotation.quadPoints);
			const [r, g, b] = annotation.color ?? [255, 255, 0];
			entries.push({
				pageNumber,
				top: rects[0]?.top ?? 0,
				colorCss: `rgb(${r}, ${g}, ${b})`,
				quote: extractQuote(rects, textContent.items),
				note: annotation.contentsObj?.str?.trim() || null,
				annotationId: annotation.id ?? null,
			});
		}
	}
	// Reading order: page ascending, then top-of-page first (PDF y grows upward).
	entries.sort((a, b) => a.pageNumber - b.pageNumber || b.top - a.top);
	return entries;
}

export class HighlightListModal extends Modal {
	private readonly pdfView: ActivePdfView;

	constructor(app: App, pdfView: ActivePdfView) {
		super(app);
		this.pdfView = pdfView;
	}

	async onOpen() {
		this.titleEl.setText('Highlights & notes');
		this.contentEl.addClass('study-pdf-list');
		this.contentEl.setText('Scanning document…');
		try {
			// getPdfJsDocument() is genuinely `any` (the live, untyped pdf.js
			// object) -- an explicit cast, not a type annotation, is what actually
			// tells the type checker this any is intentional here, rather than an
			// unchecked any silently flowing into a typed variable.
			const pdfjsDoc = this.pdfView.getPdfJsDocument() as PdfJsDocument;
			const entries = await collectHighlights(pdfjsDoc);
			this.render(entries);
		} catch (err) {
			this.contentEl.setText(`Could not read highlights -- ${(err as Error).message}`);
		}
	}

	private async copyToClipboard(text: string, what: string) {
		await navigator.clipboard.writeText(text);
		new Notice(`Copied ${what} to clipboard.`);
	}

	/** Markdown where the quoted text itself IS the deep link: clicking it in a
	 * note reopens the PDF at this exact annotation. Note follows, if any. */
	private formatEntryAsLink(entry: HighlightEntry): string {
		const subpath = entry.annotationId
			? `#page=${entry.pageNumber}&annotation=${entry.annotationId}`
			: `#page=${entry.pageNumber}`;
		const link = this.app.fileManager.generateMarkdownLink(
			this.pdfView.file,
			'',
			subpath,
			entry.quote || `p. ${entry.pageNumber}`,
		);
		const lines = [`> ${link}`];
		if (entry.note) lines.push('', entry.note);
		return lines.join('\n');
	}

	/** Plain Markdown: just the quoted text and the note, no link. */
	private formatEntryText(entry: HighlightEntry): string {
		const lines = [`> ${entry.quote || '(no text)'}`];
		if (entry.note) lines.push('', entry.note);
		return lines.join('\n');
	}

	private render(entries: HighlightEntry[]) {
		const { contentEl } = this;
		contentEl.empty();
		if (entries.length === 0) {
			contentEl.setText('No highlights in this PDF.');
			return;
		}

		const toolbar = contentEl.createDiv({ cls: 'study-pdf-list-toolbar' });
		const copyAllLinks = toolbar.createEl('button', { text: 'Copy all as links' });
		setTooltip(copyAllLinks, 'Copy every highlight as a clickable annotation link (plus notes)');
		copyAllLinks.addEventListener('click', () => {
			void this.copyToClipboard(
				entries.map((e) => this.formatEntryAsLink(e)).join('\n\n'),
				`${entries.length} highlights as links`,
			);
		});
		const copyAllText = toolbar.createEl('button', { text: 'Copy all text' });
		setTooltip(copyAllText, 'Copy every highlight and note as plain Markdown, no links');
		copyAllText.addEventListener('click', () => {
			void this.copyToClipboard(
				entries.map((e) => this.formatEntryText(e)).join('\n\n'),
				`${entries.length} highlights`,
			);
		});

		for (const entry of entries) {
			const row = contentEl.createDiv({ cls: 'study-pdf-list-row' });
			const dot = row.createSpan({ cls: 'study-pdf-color-dot' });
			dot.setCssStyles({ backgroundColor: entry.colorCss });
			const body = row.createDiv({ cls: 'study-pdf-list-body' });
			body.createDiv({ cls: 'study-pdf-list-quote', text: entry.quote || '(no text)' });
			if (entry.note) body.createDiv({ cls: 'study-pdf-list-note', text: entry.note });
			row.createDiv({ cls: 'study-pdf-list-page', text: `p. ${entry.pageNumber}` });

			const makeCopyButton = (icon: string, tooltip: string, format: () => string) => {
				const btn = row.createEl('button', { cls: 'clickable-icon study-pdf-list-copy' });
				setIcon(btn, icon);
				setTooltip(btn, tooltip);
				btn.addEventListener('click', (evt) => {
					evt.stopPropagation(); // don't also navigate
					void this.copyToClipboard(format(), 'highlight');
					setIcon(btn, 'check');
					window.setTimeout(() => setIcon(btn, icon), 1200);
				});
			};
			makeCopyButton('link', 'Copy as annotation link', () => this.formatEntryAsLink(entry));
			makeCopyButton('copy', 'Copy text only', () => this.formatEntryText(entry));

			row.addEventListener('click', () => {
				// Selecting text inside the row shouldn't teleport the viewer -- only
				// treat plain clicks as navigation.
				if (!window.getSelection()?.isCollapsed) return;
				this.pdfView.goToPage(entry.pageNumber);
				this.close();
			});
		}
	}
}
