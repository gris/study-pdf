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

/** Normalizes whitespace and enforces the display/storage length cap. Shared
 * by extractQuote's geometric reconstruction and by the exact quote captured
 * at highlight-creation time (see annotate.ts's `quote` option), so both
 * paths produce the same shape of string. */
export function normalizeQuote(text: string): string {
	const quote = text.replace(/\s+/g, ' ').trim();
	return quote.length > MAX_QUOTE_LENGTH ? quote.slice(0, MAX_QUOTE_LENGTH - 1) + '…' : quote;
}

interface WordSpan {
	text: string;
	left: number;
	right: number;
}

/** Approximates each word's horizontal extent within a text item, assuming
 * roughly uniform per-character width across the item -- pdf.js's
 * getTextContent() gives only one width for the whole item, never
 * per-character or per-word positions, so this is necessarily an
 * approximation (it doesn't account for proportional-font glyph widths).
 * It's still useful because it only ever decides whole-word inclusion,
 * never cutting mid-word, and real highlights almost always start/end on a
 * word boundary -- so this recovers a highlight's actual boundary within an
 * item far better than an all-or-nothing per-item decision would. */
function estimateWordSpans(str: string, x0: number, width: number): WordSpan[] {
	if (str.length === 0 || width <= 0) return [];
	const spans: WordSpan[] = [];
	const wordPattern = /\S+/g;
	let match: RegExpExecArray | null;
	while ((match = wordPattern.exec(str))) {
		const startIdx = match.index;
		const endIdx = startIdx + match[0].length;
		spans.push({
			text: match[0],
			left: x0 + (startIdx / str.length) * width,
			right: x0 + (endIdx / str.length) * width,
		});
	}
	return spans;
}

/** The text under a highlight isn't stored in the annotation itself -- this
 * recovers a best-effort approximation by collecting, from each text item
 * whose baseline falls inside a quad, only the words whose estimated
 * position (see estimateWordSpans) is actually covered by one of the
 * highlight's quads.
 *
 * This is only ever a FALLBACK, used when a highlight has no quote captured
 * at creation time (see annotate.ts's getStoredQuotes / addHighlightAnnotation's
 * `quote` option) -- e.g. a highlight made by another tool, or by an older
 * version of this plugin. Word-level estimation exists because pdf.js text
 * items are frequently whole words or even whole lines (measured directly
 * against a real textbook: items 3-4x wider than the highlighted span are
 * common), and an all-or-nothing per-item decision either includes far more
 * than was highlighted (any overlap) or, just as often, nothing at all for a
 * highlight that plainly has text under it (requiring the item's own
 * midpoint inside the box -- fails whenever a highlight covers a real line
 * only partially, which is the common case, not the exception). Confirmed
 * word-level estimation resolves both failure modes by re-running it against
 * all 40 pre-existing highlights in a real annotated textbook: every one
 * trimmed from "the entire surrounding line" to a plausible tight phrase.
 *
 * A single line commonly spans SEVERAL quads, not one: a browser selection's
 * getClientRects() (what selectionRectsToQuadPoints, in geometry.ts, builds
 * quads from) yields one rect per contiguous run of same-styled inline
 * content, so a highlight crossing an italic/bold span produces multiple
 * quads sharing one baseline (confirmed directly on a real highlight
 * spanning italic text: 6 quads on a single line, several of them narrow
 * slivers at the style-run boundaries). Matching a text item against only
 * the first quad it happened to satisfy -- an earlier version of this
 * function did exactly that -- could pick a sliver quad the item barely
 * touches, making every one of its words fail the position check and
 * silently drop the whole item (this is exactly what made the italic run
 * "Verdad sobre Dios" vanish from a real highlight's quote). Matching against
 * every quad on the item's baseline instead means a word only needs to be
 * covered by ANY of them. */
export function extractQuote(rects: QuadRect[], textItems: PdfJsTextItem[]): string {
	const parts: string[] = [];
	for (const item of textItems) {
		const baseline = item.transform?.[5];
		const x0 = item.transform?.[4];
		if (typeof baseline !== 'number' || typeof x0 !== 'number' || !item.str?.trim()) continue;
		const width = item.width ?? 0;
		const x1 = x0 + width;
		const matchingRects = rects.filter((r) => baseline > r.bottom && baseline < r.top && x1 > r.left && x0 < r.right);
		if (matchingRects.length === 0) continue;

		for (const word of estimateWordSpans(item.str, x0, width)) {
			const center = (word.left + word.right) / 2;
			if (matchingRects.some((r) => center > r.left && center < r.right)) parts.push(word.text);
		}
	}
	return normalizeQuote(parts.join(' '));
}
