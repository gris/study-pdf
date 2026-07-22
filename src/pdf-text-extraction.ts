// Pure logic for recovering a highlight's quoted text from a PDF page's text
// content -- no Obsidian imports, so this is directly unit-testable (see
// highlights-modal.ts, which is UI glue and imports from here).

export interface QuadRect {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

// Minimal local shape for the pdf.js text items we read -- same approach as
// PdfViewportLike in geometry.ts: capture only what we use, rather than
// depending on pdfjs-dist's real (and version-specific) types.
export interface PdfJsTextItem {
	str: string;
	transform: number[];
	width?: number;
}

const MAX_QUOTE_LENGTH = 300;

/** Normalizes pdf.js's quadPoints across the shapes it has shipped over time:
 * a flat numeric array-like (8 numbers per quad) or nested point-object arrays. */
export function quadPointsToRects(quadPoints: unknown): QuadRect[] {
	if (!quadPoints) return [];
	const rects: QuadRect[] = [];
	const fromCoords = (xs: number[], ys: number[]) => ({
		left: Math.min(...xs),
		right: Math.max(...xs),
		top: Math.max(...ys),
		bottom: Math.min(...ys),
	});

	if (Array.isArray(quadPoints) && Array.isArray(quadPoints[0])) {
		for (const quad of quadPoints as { x: number; y: number }[][]) {
			rects.push(fromCoords(quad.map((p) => p.x), quad.map((p) => p.y)));
		}
		return rects;
	}
	const flat = Array.from(quadPoints as ArrayLike<number>);
	for (let i = 0; i + 7 < flat.length; i += 8) {
		rects.push(fromCoords([flat[i]!, flat[i + 2]!, flat[i + 4]!, flat[i + 6]!], [flat[i + 1]!, flat[i + 3]!, flat[i + 5]!, flat[i + 7]!]));
	}
	return rects;
}

/** The text under a highlight isn't stored in the annotation -- recover it by
 * collecting the page's text items whose baseline falls inside a quad and
 * whose horizontal center is covered by it.
 *
 * Deliberately a center-point test, not "any horizontal overlap": pdf.js text
 * items are often whole words or even whole lines, not single characters, so
 * a highlight's edge frequently falls in the middle of an item rather than at
 * its boundary. "Any overlap" would then pull in an item's full text even
 * when the highlight only grazes it, making the copied quote consistently
 * longer than what's actually highlighted. Requiring the item's own midpoint
 * to fall inside the box instead only includes items the highlight mostly
 * covers. */
export function extractQuote(rects: QuadRect[], textItems: PdfJsTextItem[]): string {
	const parts: string[] = [];
	for (const item of textItems) {
		const baseline = item.transform?.[5];
		const x0 = item.transform?.[4];
		if (typeof baseline !== 'number' || typeof x0 !== 'number' || !item.str?.trim()) continue;
		const x1 = x0 + (item.width ?? 0);
		const centerX = (x0 + x1) / 2;
		if (rects.some((r) => baseline > r.bottom && baseline < r.top && centerX > r.left && centerX < r.right)) {
			parts.push(item.str.trim());
		}
	}
	const quote = parts.join(' ').replace(/\s+/g, ' ').trim();
	return quote.length > MAX_QUOTE_LENGTH ? quote.slice(0, MAX_QUOTE_LENGTH - 1) + '…' : quote;
}
