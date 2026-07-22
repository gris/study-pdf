import { describe, it, expect } from 'vitest';
import { extractQuote, type QuadRect, type PdfJsTextItem } from '../src/pdf-text-extraction';

// A text item's transform is [scaleX, skewX, skewY, scaleY, x, y] in PDF.js's
// getTextContent() output -- x/y (the baseline) live at indices 4/5. Only
// those two matter for extractQuote's hit-testing.
function makeItem(str: string, x: number, y: number, width: number): PdfJsTextItem {
	return { str, transform: [1, 0, 0, 1, x, y], width };
}

describe('extractQuote', () => {
	it('excludes a text item that only barely overlaps the highlight box', () => {
		// Simulates a common real-world case: pdf.js returns one large text item
		// per line (not per word), and the highlight covers only a small part of
		// it. The highlight box [100, 150] only touches the very end of a text
		// item spanning [50, 250] -- most of that item's text was never
		// highlighted and must not show up in the copied quote.
		const rects: QuadRect[] = [{ left: 100, right: 150, top: 15, bottom: 5 }];
		const items: PdfJsTextItem[] = [makeItem('a whole unhighlighted line of text', 50, 10, 200)];

		expect(extractQuote(rects, items)).toBe('');
	});

	it('includes a text item that is mostly covered by the highlight box', () => {
		const rects: QuadRect[] = [{ left: 90, right: 150, top: 15, bottom: 5 }];
		const items: PdfJsTextItem[] = [makeItem('target', 100, 10, 40)];

		expect(extractQuote(rects, items)).toBe('target');
	});

	it('excludes text items entirely outside every quad, keeps the ones inside', () => {
		const rects: QuadRect[] = [{ left: 100, right: 200, top: 15, bottom: 5 }];
		const items: PdfJsTextItem[] = [
			makeItem('before', 20, 10, 60), // x1 = 80, fully left of the box
			makeItem('target', 110, 10, 80), // x0=110, x1=190, fully inside
			makeItem('after', 220, 10, 50), // fully right of the box
		];

		expect(extractQuote(rects, items)).toBe('target');
	});

	it('joins items from multiple quads (a multi-line highlight) in order encountered', () => {
		const rects: QuadRect[] = [
			{ left: 100, right: 200, top: 25, bottom: 15 },
			{ left: 100, right: 200, top: 10, bottom: 0 },
		];
		const items: PdfJsTextItem[] = [
			makeItem('first', 110, 20, 50),
			makeItem('second', 110, 5, 50),
		];

		expect(extractQuote(rects, items)).toBe('first second');
	});
});
