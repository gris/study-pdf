// Pure coordinate-mapping logic for turning a text selection into PDF QuadPoints.
// No Obsidian or DOM imports -- keeps this unit-testable without a browser or vault.

/** The one PDF.js viewport method we depend on. Matches PDF.js's real PageViewport,
 * which already accounts for zoom scale, page rotation, and the PDF/screen origin
 * flip -- we never reimplement that transform ourselves. */
export interface PdfViewportLike {
	convertToPdfPoint(x: number, y: number): [number, number];
}

/** A rectangle in "page-local" space: CSS pixels relative to the page element's own
 * top-left corner (top-left origin), before any PDF-space conversion. */
export interface PageLocalRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** A rectangle in PDF user space (bottom-left origin, unrotated page axes). */
export interface PdfBox {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

/** Converts an absolute client rect (e.g. from Range.getClientRects()) into a rect
 * relative to the page element's origin, so it can be fed to a page's viewport. */
export function clientRectToPageLocal(
	clientRect: { left: number; top: number; right: number; bottom: number },
	pageOrigin: { x: number; y: number },
): PageLocalRect {
	return {
		left: clientRect.left - pageOrigin.x,
		top: clientRect.top - pageOrigin.y,
		right: clientRect.right - pageOrigin.x,
		bottom: clientRect.bottom - pageOrigin.y,
	};
}

/** Maps a page-local rect to a PDF-space box via the page's viewport.
 *
 * We transform all 4 corners (not just 2) and take min/max of the results, rather
 * than assuming which viewport corner becomes which PDF corner. That assumption
 * would break under rotation: PDF.js viewport transforms for 90/270 rotation swap
 * which screen axis maps to which PDF axis. Transforming all 4 corners and taking
 * min/max is rotation-agnostic and still correct because the viewport transform is
 * a similarity transform (rotation by a multiple of 90 degrees + uniform scale),
 * which always maps an axis-aligned screen rect to an axis-aligned PDF rect.
 */
export function domRectToPdfBox(rect: PageLocalRect, viewport: PdfViewportLike): PdfBox {
	const corners = [
		viewport.convertToPdfPoint(rect.left, rect.top),
		viewport.convertToPdfPoint(rect.right, rect.top),
		viewport.convertToPdfPoint(rect.left, rect.bottom),
		viewport.convertToPdfPoint(rect.right, rect.bottom),
	];
	const xs = corners.map((c) => c[0]);
	const ys = corners.map((c) => c[1]);

	return {
		// `+ 0` normalizes -0 (which convertToPdfPoint can legitimately produce,
		// e.g. at the page origin) to 0, so we never serialize "-0" into the PDF.
		left: Math.min(...xs) + 0,
		right: Math.max(...xs) + 0,
		top: Math.max(...ys) + 0,
		bottom: Math.min(...ys) + 0,
	};
}

/** Converts a PDF-space box into a single quad's 8 QuadPoints numbers, in the
 * PDF32000 "Z" vertex order: top-left, top-right, bottom-left, bottom-right.
 * (Not clockwise -- that's the common mistake that renders displaced/invisible
 * in Adobe; verified against real readers during the annotate.ts spike.) */
export function pdfBoxToQuadPoints(box: PdfBox): number[] {
	return [
		box.left, box.top,
		box.right, box.top,
		box.left, box.bottom,
		box.right, box.bottom,
	];
}

function unionPdfBoxes(boxes: PdfBox[]): PdfBox {
	const first = boxes[0];
	if (!first) {
		throw new Error('unionPdfBoxes requires at least one box');
	}
	return boxes.reduce(
		(acc, box) => ({
			left: Math.min(acc.left, box.left),
			right: Math.max(acc.right, box.right),
			top: Math.max(acc.top, box.top),
			bottom: Math.min(acc.bottom, box.bottom),
		}),
		first,
	);
}

/** True if two PDF-space boxes genuinely intersect (touching at an edge only does
 * not count). Used to find which existing highlight(s) a selection is pointing at,
 * when removing a highlight. */
export function boxesOverlap(a: PdfBox, b: PdfBox): boolean {
	return a.left < b.right && a.right > b.left && a.bottom < b.top && a.top > b.bottom;
}

/** Vertical adjustment for new highlights, as fractions of each line's own rect
 * height (positive = extend outward, negative = shrink inward).
 *
 * Not eyeballed: measured from the reference highlighter's own annotations in
 * the user's real textbook (annotation QuadPoints vs. the text items' baselines
 * and font sizes, via pdf.js). The reference draws a tight typographic box:
 * top = baseline + 0.683x font size, bottom = baseline - 0.217x. Our selection
 * rects already match at the bottom (~0.21 below baseline) but extend far
 * higher above (~0.93), so the correction is asymmetric: pull the top DOWN by
 * ~22% of the rect height, keep the bottom as-is. Symmetric padding (tried
 * first) could never match -- it grew the already-too-tall top. */
export const HIGHLIGHT_EXPAND_TOP = -0.22;
export const HIGHLIGHT_EXPAND_BOTTOM = 0;

function expandPdfBoxVertically(box: PdfBox, topRatio: number, bottomRatio: number): PdfBox {
	if (topRatio === 0 && bottomRatio === 0) return box;
	const height = box.top - box.bottom;
	return { ...box, top: box.top + height * topRatio, bottom: box.bottom - height * bottomRatio };
}

/** Smallest rect dimension, in page-local CSS pixels, that counts as real text.
 *
 * Deliberately far below one pixel: these are pre-transform coordinates, so the
 * threshold scales with the zoom, and a generous one would start eating real
 * glyphs when zoomed out (a period or a footnote superscript is only a couple
 * of points wide to begin with). The rects this exists to drop measure exactly
 * 0 -- the worst real case observed was a 0.005pt sliver -- so there is no need
 * to reach any higher. */
const MIN_RECT_SIZE_PX = 0.05;

/** Drops the empty rects a DOM selection hands back alongside the real ones --
 * an empty text span, pdf.js's `endOfContent` node, a zero-height edge.
 *
 * They paint nothing, but they join the union that becomes the annotation's
 * /Rect, and one collapsed rect at x=0 near the top of the page is enough to
 * stretch that /Rect to the full page width and a few hundred points tall.
 * pdf.js sizes the annotation layer's hit box from /Rect, so the highlight ends
 * up with a hover/click target far larger than the text it covers (measured on
 * real highlights: ~1008x460px boxes over two lines of text). */
export function dropDegenerateRects(rects: PageLocalRect[]): PageLocalRect[] {
	return rects.filter(
		(rect) =>
			Math.abs(rect.right - rect.left) >= MIN_RECT_SIZE_PX && Math.abs(rect.bottom - rect.top) >= MIN_RECT_SIZE_PX,
	);
}

/** Turns a text selection's per-line rects (already page-local) into the QuadPoints
 * array for a single PDF annotation, plus the annotation's overall bounding box
 * (for its /Rect entry). One quad per rect -- a multi-line selection becomes a
 * multi-quad highlight, same as any standard PDF highlighter. `expandTop` /
 * `expandBottom` adjust each line's quad vertically by that fraction of its
 * height (positive extends outward, negative shrinks inward). */
export function selectionRectsToQuadPoints(
	rects: PageLocalRect[],
	viewport: PdfViewportLike,
	expandTop = 0,
	expandBottom = 0,
): { quadPoints: number[]; box: PdfBox } {
	const realRects = dropDegenerateRects(rects);
	if (realRects.length === 0) {
		throw new Error('selectionRectsToQuadPoints requires at least one rect');
	}

	const boxes = realRects.map((rect) =>
		expandPdfBoxVertically(domRectToPdfBox(rect, viewport), expandTop, expandBottom),
	);
	const quadPoints = boxes.flatMap((box) => pdfBoxToQuadPoints(box));

	return { quadPoints, box: unionPdfBoxes(boxes) };
}

export interface ViewportPoint {
	x: number;
	y: number;
}

export interface ViewportRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** Whether a press landed on the current text selection.
 *
 * Used to tell "the user finished making this selection" from "the user tapped
 * somewhere else and wants it gone". iOS does not collapse a selection when you
 * tap away from it -- the selection, its native handles, and our popup all just
 * stay -- so the plugin has to make that call itself from the press position.
 *
 * `slopPx` covers releasing a drag a pixel past the last glyph, and the gaps
 * between line boxes: without it, ending a selection in the leading between two
 * lines would read as a press outside it and throw the selection away. */
export function pointWithinRects(point: ViewportPoint, rects: ViewportRect[], slopPx = 0): boolean {
	return rects.some(
		(rect) =>
			point.x >= rect.left - slopPx &&
			point.x <= rect.right + slopPx &&
			point.y >= rect.top - slopPx &&
			point.y <= rect.bottom + slopPx,
	);
}
