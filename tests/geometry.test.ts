import { describe, it, expect, beforeAll } from 'vitest';
import {
	clientRectToPageLocal,
	domRectToPdfBox,
	pdfBoxToQuadPoints,
	selectionRectsToQuadPoints,
	boxesOverlap,
	type PageLocalRect,
	type PdfViewportLike,
} from '../src/geometry';
import { loadFixturePage } from './helpers/pdf-fixture';

describe('clientRectToPageLocal', () => {
	it('subtracts the page element origin from an absolute client rect', () => {
		const clientRect = { left: 130, top: 220, right: 230, bottom: 270 };
		const pageOrigin = { x: 30, y: 20 };

		expect(clientRectToPageLocal(clientRect, pageOrigin)).toEqual({
			left: 100,
			top: 200,
			right: 200,
			bottom: 250,
		});
	});
});

describe('domRectToPdfBox', () => {
	let page: Awaited<ReturnType<typeof loadFixturePage>>;

	beforeAll(async () => {
		page = await loadFixturePage();
	});

	it('maps a page-local rect to PDF space at scale 1, rotation 0 (known values)', () => {
		const viewport = page.getViewport({ scale: 1, rotation: 0 }) as PdfViewportLike;
		const rect: PageLocalRect = { left: 0, top: 0, right: 100, bottom: 50 };

		// Verified independently against pdfjs-dist's own convertToPdfPoint:
		// viewport (0,0) -> PDF (0, 300); viewport (100,50) -> PDF (100, 250).
		expect(domRectToPdfBox(rect, viewport)).toEqual({
			left: 0,
			right: 100,
			top: 300,
			bottom: 250,
		});
	});

	it.each([0, 90, 180, 270])(
		'produces an axis-aligned box whose corners match convertToPdfPoint at rotation %i',
		(rotation) => {
			const viewport = page.getViewport({ scale: 1.5, rotation }) as PdfViewportLike;
			const rect: PageLocalRect = { left: 40, top: 60, right: 140, bottom: 90 };

			// Ground truth computed independently from the same primitive our function
			// must use, but the aggregation (min/max across all 4 corners) mirrors what
			// domRectToPdfBox is actually responsible for getting right -- this is what
			// breaks if the rotation-driven axis swap is handled incorrectly.
			const corners = [
				viewport.convertToPdfPoint(rect.left, rect.top),
				viewport.convertToPdfPoint(rect.right, rect.top),
				viewport.convertToPdfPoint(rect.left, rect.bottom),
				viewport.convertToPdfPoint(rect.right, rect.bottom),
			];
			const xs = corners.map((c) => c[0]);
			const ys = corners.map((c) => c[1]);
			const expectedBox = {
				left: Math.min(...xs),
				right: Math.max(...xs),
				top: Math.max(...ys),
				bottom: Math.min(...ys),
			};

			const box = domRectToPdfBox(rect, viewport);
			expect(box.left).toBeCloseTo(expectedBox.left, 6);
			expect(box.right).toBeCloseTo(expectedBox.right, 6);
			expect(box.top).toBeCloseTo(expectedBox.top, 6);
			expect(box.bottom).toBeCloseTo(expectedBox.bottom, 6);
		},
	);
});

describe('pdfBoxToQuadPoints', () => {
	it('orders vertices in PDF32000 Z order: top-left, top-right, bottom-left, bottom-right', () => {
		const box = { left: 10, right: 50, top: 100, bottom: 80 };
		expect(pdfBoxToQuadPoints(box)).toEqual([
			10, 100, // top-left
			50, 100, // top-right
			10, 80, // bottom-left
			50, 80, // bottom-right
		]);
	});
});

describe('boxesOverlap', () => {
	it('is true when two boxes genuinely intersect', () => {
		const a = { left: 0, right: 100, top: 50, bottom: 0 };
		const b = { left: 50, right: 150, top: 60, bottom: 10 };
		expect(boxesOverlap(a, b)).toBe(true);
		expect(boxesOverlap(b, a)).toBe(true); // symmetric
	});

	it('is false when boxes are disjoint', () => {
		const a = { left: 0, right: 100, top: 50, bottom: 0 };
		const b = { left: 200, right: 300, top: 50, bottom: 0 };
		expect(boxesOverlap(a, b)).toBe(false);
	});

	it('is false when boxes only touch at an edge (no true overlap)', () => {
		const a = { left: 0, right: 100, top: 50, bottom: 0 };
		const b = { left: 100, right: 200, top: 50, bottom: 0 }; // shares the x=100 edge
		expect(boxesOverlap(a, b)).toBe(false);
	});

	it('is true when one box is fully inside the other', () => {
		const outer = { left: 0, right: 100, top: 100, bottom: 0 };
		const inner = { left: 10, right: 20, top: 20, bottom: 10 };
		expect(boxesOverlap(outer, inner)).toBe(true);
	});

	it('correctly treats a zero-area box (a click/caret point) as a point-in-rect test', () => {
		// Load-bearing for "click to remove a highlight": a collapsed selection's
		// rect has left===right and top===bottom, i.e. a point, not a real box.
		const highlight = { left: 10, right: 100, top: 50, bottom: 0 };
		const pointInside = { left: 50, right: 50, top: 25, bottom: 25 };
		const pointOutside = { left: 200, right: 200, top: 25, bottom: 25 };
		expect(boxesOverlap(highlight, pointInside)).toBe(true);
		expect(boxesOverlap(highlight, pointOutside)).toBe(false);
	});
});

describe('selectionRectsToQuadPoints', () => {
	let page: Awaited<ReturnType<typeof loadFixturePage>>;

	beforeAll(async () => {
		page = await loadFixturePage();
	});

	it('emits one quad per rect (multi-line selection) and unions the bounding box', () => {
		const viewport = page.getViewport({ scale: 1, rotation: 0 }) as PdfViewportLike;
		// Two "lines" of a selection, stacked vertically on screen.
		const rects: PageLocalRect[] = [
			{ left: 0, top: 0, right: 100, bottom: 20 },
			{ left: 0, top: 20, right: 60, bottom: 40 },
		];

		const result = selectionRectsToQuadPoints(rects, viewport);

		expect(result.quadPoints).toHaveLength(16); // 2 rects * 8 numbers
		// Line 1 quad
		expect(result.quadPoints.slice(0, 8)).toEqual(pdfBoxToQuadPoints(domRectToPdfBox(rects[0]!, viewport)));
		// Line 2 quad
		expect(result.quadPoints.slice(8, 16)).toEqual(pdfBoxToQuadPoints(domRectToPdfBox(rects[1]!, viewport)));

		// Union box spans both lines and the wider of the two rects.
		expect(result.box).toEqual({ left: 0, right: 100, top: 300, bottom: 260 });
	});

	it('adjusts each line quad vertically by independent top/bottom ratios (marker-style sizing)', () => {
		const viewport = page.getViewport({ scale: 1, rotation: 0 }) as PdfViewportLike;
		const rects: PageLocalRect[] = [{ left: 0, top: 100, right: 100, bottom: 120 }];

		const plain = selectionRectsToQuadPoints(rects, viewport);
		// Negative top shrinks the box downward from the top; positive bottom
		// extends it downward -- the asymmetric shape our calibration needs.
		const adjusted = selectionRectsToQuadPoints(rects, viewport, -0.22, 0.05);

		const height = plain.box.top - plain.box.bottom;
		expect(adjusted.box.top).toBeCloseTo(plain.box.top - 0.22 * height, 6);
		expect(adjusted.box.bottom).toBeCloseTo(plain.box.bottom - 0.05 * height, 6);
		expect(adjusted.box.left).toBe(plain.box.left);
		expect(adjusted.box.right).toBe(plain.box.right);
		expect(adjusted.quadPoints).toEqual(pdfBoxToQuadPoints(adjusted.box));
	});
});
