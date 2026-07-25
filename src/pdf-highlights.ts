// Reads every /Highlight annotation out of the viewer's LIVE pdf.js document:
// no file re-parse, and no need to bundle our own copy of pdf.js. Shared by the
// highlights modal and the "Export highlights to note" command, so both see the
// same list in the same order.
//
// No Obsidian imports -- the pdf.js document is passed in.
import { quadPointsToRects, extractQuote, type PdfJsTextItem } from './pdf-text-extraction';

export interface HighlightEntry {
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
export interface PdfJsAnnotation {
	subtype?: string;
	quadPoints?: unknown;
	color?: number[];
	contentsObj?: { str?: string };
	id?: string;
}

export interface PdfJsPage {
	getAnnotations(): Promise<PdfJsAnnotation[]>;
	getTextContent(): Promise<{ items: PdfJsTextItem[] }>;
}

export interface PdfJsDocument {
	numPages: number;
	getPage(pageNumber: number): Promise<PdfJsPage>;
}

export async function collectHighlights(
	pdfjsDoc: PdfJsDocument,
	storedQuotes: Map<number, (string | null)[]>,
): Promise<HighlightEntry[]> {
	const entries: HighlightEntry[] = [];
	for (let pageNumber = 1; pageNumber <= pdfjsDoc.numPages; pageNumber++) {
		const page = await pdfjsDoc.getPage(pageNumber);
		const annotations = await page.getAnnotations();
		const highlights = annotations.filter((a) => a.subtype === 'Highlight');
		if (highlights.length === 0) continue;

		const textContent = await page.getTextContent();
		// 0-based to match getStoredQuotes' keys; order matches its own
		// per-page Highlight-only array (see that function's doc comment).
		const pageStoredQuotes = storedQuotes.get(pageNumber - 1);
		highlights.forEach((annotation, indexOnPage) => {
			const rects = quadPointsToRects(annotation.quadPoints);
			const [r, g, b] = annotation.color ?? [255, 255, 0];
			entries.push({
				pageNumber,
				top: rects[0]?.top ?? 0,
				colorCss: `rgb(${r}, ${g}, ${b})`,
				quote: pageStoredQuotes?.[indexOnPage] || extractQuote(rects, textContent.items),
				note: annotation.contentsObj?.str?.trim() || null,
				annotationId: annotation.id ?? null,
			});
		});
	}
	// Reading order: page ascending, then top-of-page first (PDF y grows upward).
	// Two highlights on the same line tie on `top`; a stable sort leaves them in
	// /Annots order, which is what makes re-exporting an unchanged PDF a no-op.
	entries.sort((a, b) => a.pageNumber - b.pageNumber || b.top - a.top);
	return entries;
}
