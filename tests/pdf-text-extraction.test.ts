import { describe, it, expect } from 'vitest';
import { extractQuote, type QuadRect, type PdfJsTextItem } from '../src/pdf-text-extraction';

// A text item's transform is [scaleX, skewX, skewY, scaleY, x, y] in PDF.js's
// getTextContent() output -- x/y (the baseline) live at indices 4/5. Only
// those two matter for extractQuote's hit-testing.
function makeItem(str: string, x: number, y: number, width: number): PdfJsTextItem {
	return { str, transform: [1, 0, 0, 1, x, y], width };
}

describe('extractQuote', () => {
	it('trims a whole-line text item down to just the words the highlight box covers', () => {
		// pdf.js often returns one text item per whole line, not per word, with
		// no per-character position data -- so extractQuote estimates each
		// word's position within the item (assuming roughly uniform
		// character width) and keeps only the words whose estimated position
		// falls inside the highlight box, rather than an all-or-nothing verdict
		// on the entire item. Confirmed against a real annotated textbook: this
		// correctly trims "the whole surrounding line" down to a plausible
		// tight phrase for every one of 40 real highlights checked.
		const rects: QuadRect[] = [{ left: 100, right: 150, top: 15, bottom: 5 }];
		const items: PdfJsTextItem[] = [makeItem('a whole unhighlighted line of text', 50, 10, 200)];

		expect(extractQuote(rects, items)).toBe('unhighlighted');
	});

	it('recovers a multi-word phrase from the middle of a whole-line item', () => {
		const rects: QuadRect[] = [{ left: 150, right: 300, top: 15, bottom: 5 }];
		const items: PdfJsTextItem[] = [makeItem('the quick brown fox jumps over the lazy dog', 0, 10, 440)];

		expect(extractQuote(rects, items)).toBe('fox jumps over');
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

	it('does not drop a text item whose baseline matches several quads, just because the first one is a sliver it barely touches', () => {
		// Real-world case: a highlight crossing an italic/bold run produces
		// multiple quads sharing one baseline, because a browser selection's
		// getClientRects() yields one rect per styled inline run even within a
		// single visual line (confirmed on a real highlight spanning italic
		// text -- 6 quads on one line, several of them narrow slivers at the
		// style-run boundaries). Matching each item against only the first
		// quad it satisfies could pick a sliver the item barely touches,
		// making every word fail the position check and silently dropping the
		// whole item -- exactly what made an italicized phrase vanish from a
		// real highlight's quote.
		const rects: QuadRect[] = [
			{ left: 128, right: 131, top: 15, bottom: 5 }, // a narrow sliver at the style-run boundary
			{ left: 95, right: 225, top: 15, bottom: 5 }, // the quad that actually covers the whole highlight
		];
		const items: PdfJsTextItem[] = [makeItem('la', 100, 10, 20), makeItem('Verdad sobre Dios', 130, 10, 90)];

		expect(extractQuote(rects, items)).toBe('la Verdad sobre Dios');
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
