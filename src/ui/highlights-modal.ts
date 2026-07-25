// "Show all highlights and notes": a native Obsidian Modal listing every
// /Highlight annotation in the open PDF -- color dot, the highlighted text
// (recovered by matching the annotation's QuadPoints against the page's text
// items), the note if any, and the page number. Clicking a row jumps there.
//
// UI glue only: the reading of the live pdf.js document lives in
// pdf-highlights.ts and the Markdown shapes in highlight-export.ts, both shared
// with the "Export highlights to note" command.
import { Modal, Notice, setIcon, setTooltip, type App } from 'obsidian';
import type { ActivePdfView } from '../obsidian-pdf-internals';
import { getStoredQuotes } from '../annotate';
import { collectHighlights, type HighlightEntry, type PdfJsDocument } from '../pdf-highlights';
import { buildEntryLink, formatQuoteBlock } from '../highlight-export';

export class HighlightListModal extends Modal {
	private readonly pdfView: ActivePdfView;
	private readonly onExport: () => Promise<void>;

	constructor(app: App, pdfView: ActivePdfView, onExport: () => Promise<void>) {
		super(app);
		this.pdfView = pdfView;
		this.onExport = onExport;
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
			const fileBytes = new Uint8Array(await this.app.vault.readBinary(this.pdfView.file));
			const storedQuotes = await getStoredQuotes(fileBytes);
			const entries = await collectHighlights(pdfjsDoc, storedQuotes);
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
		const link = buildEntryLink(entry, (subpath, alias) =>
			this.app.fileManager.generateMarkdownLink(this.pdfView.file, '', subpath, alias),
		);
		return formatQuoteBlock(link, entry.note);
	}

	/** Plain Markdown: just the quoted text and the note, no link. */
	private formatEntryText(entry: HighlightEntry): string {
		return formatQuoteBlock(entry.quote || '(no text)', entry.note);
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

		// Last, not first: this one writes a file, so it shouldn't sit where the
		// copy buttons have trained the user's click to land. Closing first keeps
		// the modal from covering the note when a new one opens in a tab.
		const exportToNote = toolbar.createEl('button', { text: 'Export to note' });
		setTooltip(exportToNote, 'Write these highlights into a note beside the PDF');
		exportToNote.addEventListener('click', () => {
			this.close();
			void this.onExport();
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
