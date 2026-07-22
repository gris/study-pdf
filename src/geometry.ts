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
	if (rects.length === 0) {
		throw new Error('selectionRectsToQuadPoints requires at least one rect');
	}

	const boxes = rects.map((rect) => expandPdfBoxVertically(domRectToPdfBox(rect, viewport), expandTop, expandBottom));
	const quadPoints = boxes.flatMap((box) => pdfBoxToQuadPoints(box));

	return { quadPoints, box: unionPdfBoxes(boxes) };
}
