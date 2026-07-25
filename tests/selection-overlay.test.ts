import { describe, it, expect } from 'vitest';
import { normalizeOverlayRects, type OverlayRect } from '../src/ui/selection-overlay';

const rect = (left: number, top: number, width: number, height: number): OverlayRect => ({
	left,
	top,
	width,
	height,
});

describe('normalizeOverlayRects', () => {
	it('drops zero-area rects', () => {
		// getClientRects() emits empty slivers at line ends and around collapsed
		// ranges; painted with mix-blend-mode they show up as stray 1px marks.
		const input = [rect(10, 10, 100, 20), rect(10, 10, 0, 20), rect(10, 10, 100, 0)];

		expect(normalizeOverlayRects(input)).toEqual([rect(10, 10, 100, 20)]);
	});

	it('merges abutting rects on the same line into one', () => {
		// Adjacent text-layer spans produce one rect each. Painting them
		// separately double-darkens the overlap under mix-blend-mode.
		const input = [rect(10, 100, 50, 20), rect(60, 100, 40, 20)];

		expect(normalizeOverlayRects(input)).toEqual([rect(10, 100, 90, 20)]);
	});

	it('merges overlapping rects on the same line', () => {
		const input = [rect(10, 100, 50, 20), rect(40, 100, 50, 20)];

		expect(normalizeOverlayRects(input)).toEqual([rect(10, 100, 80, 20)]);
	});

	it('keeps rects on different lines separate', () => {
		const input = [rect(10, 100, 50, 20), rect(10, 130, 50, 20)];

		expect(normalizeOverlayRects(input)).toHaveLength(2);
	});

	it('keeps a gap on the same line separate', () => {
		// A multi-column page can select two disjoint runs on one visual line;
		// bridging them would paint over unselected text in between.
		const input = [rect(10, 100, 50, 20), rect(200, 100, 50, 20)];

		expect(normalizeOverlayRects(input)).toHaveLength(2);
	});

	it('tolerates sub-pixel differences in line position and height', () => {
		// Text-layer rects rarely land on exact pixels at fractional zoom.
		const input = [rect(10, 100, 50, 20), rect(60, 100.4, 40, 20.3)];

		expect(normalizeOverlayRects(input)).toHaveLength(1);
	});

	it('merges same-line rects that differ by several pixels in top and height', () => {
		// Captured from a real selection in the live viewer: one line yielded two
		// overlapping rects 2px apart vertically with different heights, which an
		// exact-match merge left as two stacked translucent layers.
		const input = [rect(347, 323, 526, 23), rect(347, 321, 526, 27)];

		expect(normalizeOverlayRects(input)).toEqual([rect(347, 321, 526, 27)]);
	});

	it('separates consecutive lines that nearly touch', () => {
		// The flip side of the tolerance above: line boxes can abut exactly, and
		// merging them would smear the overlay into one tall block.
		const input = [rect(347, 281, 489, 27), rect(347, 308, 489, 27)];

		expect(normalizeOverlayRects(input)).toHaveLength(2);
	});

	it('returns an empty list unchanged', () => {
		expect(normalizeOverlayRects([])).toEqual([]);
	});
});
