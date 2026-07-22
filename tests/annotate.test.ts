import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, PDFArray, PDFRawStream, PDFString, EncryptedPDFError } from '@cantoo/pdf-lib';
import {
	addHighlightAnnotation,
	removeHighlightsAt,
	hasHighlightAt,
	inspectHighlightAt,
	setHighlightNoteAt,
	getStoredQuotes,
} from '../src/annotate';
import { makeFixturePdfBytes, makeEncryptedFixturePdfBytes, loadPdfjsDoc } from './helpers/pdf-fixture';
import {
	makeComplexFixturePdfBytes,
	inspectComplexFixture,
	COMPLEX_FIXTURE_PAGE_COUNT,
	LINK_ANNOTATION_URI,
	FORM_FIELD_VALUE,
	PAGE_2_TEXT,
} from './helpers/complex-fixture';

const YELLOW = { r: 1, g: 0.92, b: 0.2 };

describe('addHighlightAnnotation', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('highlights an owner-password-encrypted PDF (the common "protected" textbook/scan case)', async () => {
		// These files open in any viewer without a password prompt (empty user
		// password); only permissions are restricted. The user's real course
		// textbook is exactly this -- verified live on a copy: 544 pages, loads
		// with password "", resaves cleanly.
		const bytes = await makeEncryptedFixturePdfBytes();
		// Sanity: the fixture really is encrypted -- a plain load must refuse it.
		await expect(PDFDocument.load(bytes)).rejects.toThrow(EncryptedPDFError);

		const box = { left: 0, right: 10, top: 10, bottom: 0 };
		const result = await addHighlightAnnotation(bytes, {
			pageIndex: 0,
			quadPoints: [box.left, box.top, box.right, box.top, box.left, box.bottom, box.right, box.bottom],
			box,
			color: YELLOW,
		});

		// The output is saved decrypted (permission flags dropped, content
		// identical): it must load plainly and contain the highlight.
		const doc = await PDFDocument.load(result);
		const annots = doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
		expect(annots?.size()).toBe(1);
	});

	it('fails fast with a clear message on a PDF that genuinely requires a password to open', async () => {
		const bytes = await makeEncryptedFixturePdfBytes({ userPassword: 'open-secret' });

		const box = { left: 0, right: 10, top: 10, bottom: 0 };
		await expect(
			addHighlightAnnotation(bytes, {
				pageIndex: 0,
				quadPoints: [box.left, box.top, box.right, box.top, box.left, box.bottom, box.right, box.bottom],
				box,
				color: YELLOW,
			}),
		).rejects.toThrow(/password/i);
	});

	it('refuses to return bytes if the post-save reload looks corrupted (page count mismatch)', async () => {
		// Simulate pdf-lib's save() silently dropping a page: the internal verify
		// reload (the second PDFDocument.load call, after pdfDoc.save()) sees one
		// fewer page than the original. This exercises the real safety guard in
		// annotate.ts, not a reimplementation of its logic.
		const bytes = await makeFixturePdfBytes();
		const originalLoad = PDFDocument.load.bind(PDFDocument);
		let loadCallCount = 0;
		vi.spyOn(PDFDocument, 'load').mockImplementation(async (input) => {
			loadCallCount++;
			const doc = await originalLoad(input as Uint8Array);
			if (loadCallCount === 2) {
				doc.addPage(); // makes the "verify" reload's page count diverge
			}
			return doc;
		});

		const box = { left: 0, right: 10, top: 10, bottom: 0 };
		await expect(
			addHighlightAnnotation(bytes, {
				pageIndex: 0,
				quadPoints: [box.left, box.top, box.right, box.top, box.left, box.bottom, box.right, box.bottom],
				box,
				color: YELLOW,
			}),
		).rejects.toThrow(/page count changed/);
	});

	it('rejects a quadPoints array that is not a non-empty multiple of 8', async () => {
		const bytes = await makeFixturePdfBytes();
		await expect(
			addHighlightAnnotation(bytes, { pageIndex: 0, quadPoints: [1, 2, 3], box: { left: 0, right: 1, top: 1, bottom: 0 }, color: YELLOW }),
		).rejects.toThrow(/multiple of 8/);
		await expect(
			addHighlightAnnotation(bytes, { pageIndex: 0, quadPoints: [], box: { left: 0, right: 1, top: 1, bottom: 0 }, color: YELLOW }),
		).rejects.toThrow(/multiple of 8/);
	});

	it('produces a PDF whose page has a real, renderable /Highlight annotation (tiny fixture round-trip)', async () => {
		const bytes = await makeFixturePdfBytes();
		const box = { left: 50, right: 250, top: 220, bottom: 195 };
		const quadPoints = [box.left, box.top, box.right, box.top, box.left, box.bottom, box.right, box.bottom];

		const highlighted = await addHighlightAnnotation(bytes, {
			pageIndex: 0,
			quadPoints,
			box,
			color: YELLOW,
			opacity: 0.4,
		});

		const doc = await loadPdfjsDoc(highlighted);
		const page = await doc.getPage(1);
		const annotations = await page.getAnnotations();

		expect(annotations).toHaveLength(1);
		const annot = annotations[0];
		expect(annot.subtype).toBe('Highlight');
		expect(annot.rect).toEqual([box.left, box.bottom, box.right, box.top]);
		expect(Object.values(annot.quadPoints)).toEqual(quadPoints.map((n) => expect.closeTo(n, 3)));
		// pdf-lib stores color 0..1; pdfjs reports it back scaled to 0..255.
		expect(annot.color[0]).toBeCloseTo(255, 0);
		expect(annot.color[1]).toBeCloseTo(235, 0);
		expect(annot.color[2]).toBeCloseTo(51, 0);
		expect(annot.opacity).toBeCloseTo(0.4, 5);
		expect(annot.hasAppearance).toBe(true);
	});

	it('preserves unrelated content through a full re-serialization (complex fixture data-safety check)', async () => {
		const original = await makeComplexFixturePdfBytes();
		const before = await inspectComplexFixture(original);
		expect(before.pageCount).toBe(COMPLEX_FIXTURE_PAGE_COUNT);
		expect(before.linkUris).toEqual([LINK_ANNOTATION_URI]);
		expect(before.fieldValue).toBe(FORM_FIELD_VALUE);

		const originalDoc = await loadPdfjsDoc(original);
		const originalPage2 = await originalDoc.getPage(3); // 1-indexed in pdfjs
		const originalPage2Text = (await originalPage2.getTextContent()).items
			.map((item: { str?: string }) => item.str ?? '')
			.join('');

		// Highlight text on page 2 (index 1) -- neither the untouched page 3 nor
		// page 1's pre-existing annotation/form field should be affected.
		const box = { left: 20, right: 200, top: 262, bottom: 248 };
		const quadPoints = [box.left, box.top, box.right, box.top, box.left, box.bottom, box.right, box.bottom];
		const highlighted = await addHighlightAnnotation(original, {
			pageIndex: 1,
			quadPoints,
			box,
			color: YELLOW,
		});

		const after = await inspectComplexFixture(highlighted);
		expect(after.pageCount).toBe(before.pageCount);
		expect(after.linkUris).toEqual(before.linkUris);
		expect(after.fieldValue).toBe(before.fieldValue);

		const afterDoc = await loadPdfjsDoc(highlighted);
		const afterPage2 = await afterDoc.getPage(3);
		const afterPage2Text = (await afterPage2.getTextContent()).items
			.map((item: { str?: string }) => item.str ?? '')
			.join('');
		expect(afterPage2Text).toBe(originalPage2Text);
		expect(afterPage2Text).toBe(PAGE_2_TEXT);

		// And the highlight itself really did land on the intended page.
		const highlightedPage = await afterDoc.getPage(2);
		const annotations = await highlightedPage.getAnnotations();
		expect(annotations).toHaveLength(1);
		expect(annotations[0].subtype).toBe('Highlight');
	});

	it('appends to a page that already has an annotation, rather than clobbering it', async () => {
		const bytes = await makeFixturePdfBytes();
		const box1 = { left: 10, right: 100, top: 220, bottom: 200 };
		const quad1 = [box1.left, box1.top, box1.right, box1.top, box1.left, box1.bottom, box1.right, box1.bottom];
		const withFirst = await addHighlightAnnotation(bytes, { pageIndex: 0, quadPoints: quad1, box: box1, color: YELLOW });

		const box2 = { left: 10, right: 100, top: 150, bottom: 130 };
		const quad2 = [box2.left, box2.top, box2.right, box2.top, box2.left, box2.bottom, box2.right, box2.bottom];
		const withBoth = await addHighlightAnnotation(withFirst, { pageIndex: 0, quadPoints: quad2, box: box2, color: { r: 0, g: 1, b: 0 } });

		const doc = await loadPdfjsDoc(withBoth);
		const page = await doc.getPage(1);
		const annotations = await page.getAnnotations();

		expect(annotations).toHaveLength(2);
		expect(annotations.every((a: { subtype: string }) => a.subtype === 'Highlight')).toBe(true);
		const rects = annotations.map((a: { rect: number[] }) => a.rect);
		expect(rects).toContainEqual([box1.left, box1.bottom, box1.right, box1.top]);
		expect(rects).toContainEqual([box2.left, box2.bottom, box2.right, box2.top]);
	});

	/** Counts /Widget annotations (form field appearances) across every page,
	 * without ever calling pdfDoc.getForm() -- see note below on why. */
	function countWidgetAnnotations(doc: PDFDocument): number {
		let count = 0;
		for (const page of doc.getPages()) {
			const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
			if (!annots) continue;
			for (let i = 0; i < annots.size(); i++) {
				const dict = doc.context.lookup(annots.get(i)) as unknown as {
					get(name: ReturnType<typeof PDFName.of>): { toString(): string } | undefined;
				};
				if (dict.get?.(PDFName.of('Subtype'))?.toString() === '/Widget') count++;
			}
		}
		return count;
	}

	it('preserves a real, non-pdf-lib-authored PDF through a full re-serialization', async () => {
		// tests/fixtures/sample-form.pdf is a hand-authored, classic-xref PDF (not
		// pdf-lib-generated) with two pages, a merged Widget/field annotation, and
		// an /AcroForm XFA entry -- a neutral stand-in for the kind of real-world,
		// enterprise-tool-authored form PDF users actually highlight. The earlier
		// "complex fixture" test round-trips a PDF pdf-lib itself authored, which
		// can't surface bugs specific to structures pdf-lib didn't write. This one
		// can, without depending on any specific real-world document.
		//
		// Note: this fixture has XFA form data (common in government/enterprise
		// forms). pdf-lib silently deletes /AcroForm's XFA entry the moment
		// anything calls pdfDoc.getForm() -- confirmed via node_modules/pdf-lib
		// PDFDocument.js's getForm(). Our production addHighlightAnnotation never
		// calls getForm(), so it doesn't trigger this, but this test deliberately
		// avoids the Form API too (using raw dict/XFA checks instead) so it
		// verifies OUR code's behavior, not pdf-lib's unrelated footgun.
		const fixturePath = fileURLToPath(new URL('./fixtures/sample-form.pdf', import.meta.url));
		const original = new Uint8Array(readFileSync(fixturePath));

		const beforeDoc = await PDFDocument.load(original);
		const pageCountBefore = beforeDoc.getPageCount();
		const widgetCountBefore = countWidgetAnnotations(beforeDoc);
		const acroFormBefore = beforeDoc.catalog.lookup(PDFName.of('AcroForm')) as unknown as {
			get(name: ReturnType<typeof PDFName.of>): unknown;
		};
		const hadXfaBefore = acroFormBefore.get(PDFName.of('XFA')) !== undefined;
		expect(pageCountBefore).toBeGreaterThan(1);
		expect(widgetCountBefore).toBeGreaterThan(0);
		expect(hadXfaBefore).toBe(true); // sanity: confirms this fixture actually exercises the XFA path

		const lastPageIndex = pageCountBefore - 1;
		const originalPdfjs = await loadPdfjsDoc(original);
		const lastPageBefore = await originalPdfjs.getPage(lastPageIndex + 1); // pdfjs is 1-indexed
		const lastPageTextBefore = (await lastPageBefore.getTextContent()).items
			.map((item: { str?: string }) => item.str ?? '')
			.join('');

		// Highlight something on page 1 -- nowhere near the untouched last page.
		const box = { left: 50, right: 300, top: 700, bottom: 680 };
		const quadPoints = [box.left, box.top, box.right, box.top, box.left, box.bottom, box.right, box.bottom];
		const highlighted = await addHighlightAnnotation(original, {
			pageIndex: 0,
			quadPoints,
			box,
			color: YELLOW,
		});

		const afterDoc = await PDFDocument.load(highlighted);
		expect(afterDoc.getPageCount()).toBe(pageCountBefore);
		expect(countWidgetAnnotations(afterDoc)).toBe(widgetCountBefore);
		const acroFormAfter = afterDoc.catalog.lookup(PDFName.of('AcroForm')) as unknown as {
			get(name: ReturnType<typeof PDFName.of>): unknown;
		};
		expect(acroFormAfter.get(PDFName.of('XFA')) !== undefined).toBe(hadXfaBefore);

		const afterPdfjs = await loadPdfjsDoc(highlighted);
		const lastPageAfter = await afterPdfjs.getPage(lastPageIndex + 1);
		const lastPageTextAfter = (await lastPageAfter.getTextContent()).items
			.map((item: { str?: string }) => item.str ?? '')
			.join('');
		expect(lastPageTextAfter).toBe(lastPageTextBefore);

		const highlightedPage = await afterPdfjs.getPage(1);
		const annotations = await highlightedPage.getAnnotations();
		const highlights = annotations.filter((a: { subtype: string }) => a.subtype === 'Highlight');
		expect(highlights).toHaveLength(1);
	});

	it('draws one appearance rect per quad, not one rect over the whole union box (multi-line safety)', async () => {
		// Two disjoint quads (as a two-line selection with a gap would produce).
		// The union box spans the gap; the appearance stream must not fill it.
		const bytes = await makeFixturePdfBytes();
		const box = { left: 0, right: 200, top: 220, bottom: 100 }; // union spans a big vertical gap
		const quadPoints = [
			0, 220, 200, 220, 0, 200, 200, 200, // line 1: y in [200,220]
			0, 120, 100, 120, 0, 100, 100, 100, // line 2: y in [100,120], narrower
		];

		const highlighted = await addHighlightAnnotation(bytes, { pageIndex: 0, quadPoints, box, color: YELLOW });

		// Read the /AP stream's actual content back out via pdf-lib and confirm it
		// contains two separate `re` (rectangle) fills -- not one rect spanning the
		// full union-box height, which would paint over the gap between the lines.
		const reloaded = await PDFDocument.load(highlighted);
		const page = reloaded.getPage(0);
		const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const annotDict = reloaded.context.lookup(annots.get(0)) as any;
		const ap = reloaded.context.lookup(annotDict.get(PDFName.of('AP'))) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
		const apStream = reloaded.context.lookup(ap.get(PDFName.of('N'))) as PDFRawStream;
		const content = apStream.getContentsString();
		const reCount = (content.match(/ re\b/g) ?? []).length;

		expect(reCount).toBe(2);
	});
});

describe('captured quote (custom StudyPDFQuote key)', () => {
	// The text under a highlight can't be reliably reconstructed from PDF
	// geometry alone: pdf.js's text items are often whole words or whole lines,
	// and a highlight covering only part of one can't be sliced to just that
	// part without per-character position data getTextContent() doesn't provide
	// (measured directly against a real textbook: highlights regularly land on
	// items 3-4x wider than the highlighted span). So the real fix is to record
	// the exact text the user had selected at creation time, and store it
	// alongside the annotation -- geometric reconstruction (extractQuote in
	// pdf-text-extraction.ts) then only has to cover foreign/legacy highlights
	// that never had a quote captured.
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('stores the exact selected text at creation time, retrievable via getStoredQuotes', async () => {
		const bytes = await makeFixturePdfBytes();
		const box = { left: 10, right: 100, top: 220, bottom: 200 };
		const quad = [box.left, box.top, box.right, box.top, box.left, box.bottom, box.right, box.bottom];
		const highlighted = await addHighlightAnnotation(bytes, {
			pageIndex: 0,
			quadPoints: quad,
			box,
			color: YELLOW,
			quote: 'the exact phrase the user selected',
		});

		const quotes = await getStoredQuotes(highlighted);
		expect(quotes.get(0)).toEqual(['the exact phrase the user selected']);
	});

	it('does not store a quote when none is given -- reads back as null, not an empty string', async () => {
		const bytes = await makeFixturePdfBytes();
		const box = { left: 10, right: 100, top: 220, bottom: 200 };
		const quad = [box.left, box.top, box.right, box.top, box.left, box.bottom, box.right, box.bottom];
		const highlighted = await addHighlightAnnotation(bytes, { pageIndex: 0, quadPoints: quad, box, color: YELLOW });

		const quotes = await getStoredQuotes(highlighted);
		expect(quotes.get(0)).toEqual([null]);
	});

	it('keeps quotes in per-page annotation order across multiple highlights', async () => {
		const bytes = await makeFixturePdfBytes();
		const box1 = { left: 10, right: 100, top: 220, bottom: 200 };
		const quad1 = [box1.left, box1.top, box1.right, box1.top, box1.left, box1.bottom, box1.right, box1.bottom];
		const withFirst = await addHighlightAnnotation(bytes, {
			pageIndex: 0,
			quadPoints: quad1,
			box: box1,
			color: YELLOW,
			quote: 'first',
		});

		const box2 = { left: 10, right: 100, top: 150, bottom: 130 };
		const quad2 = [box2.left, box2.top, box2.right, box2.top, box2.left, box2.bottom, box2.right, box2.bottom];
		const withBoth = await addHighlightAnnotation(withFirst, {
			pageIndex: 0,
			quadPoints: quad2,
			box: box2,
			color: YELLOW,
			quote: 'second',
		});

		const quotes = await getStoredQuotes(withBoth);
		expect(quotes.get(0)).toEqual(['first', 'second']);
	});

	it('unicode survives round-trip intact (accents, ñ)', async () => {
		const bytes = await makeFixturePdfBytes();
		const box = { left: 10, right: 100, top: 220, bottom: 200 };
		const quad = [box.left, box.top, box.right, box.top, box.left, box.bottom, box.right, box.bottom];
		const highlighted = await addHighlightAnnotation(bytes, {
			pageIndex: 0,
			quadPoints: quad,
			box,
			color: YELLOW,
			quote: 'cañón, café',
		});

		expect((await getStoredQuotes(highlighted)).get(0)).toEqual(['cañón, café']);
	});

	it('survives setHighlightNoteAt re-saving the document (adding a note keeps the stored quote)', async () => {
		const bytes = await makeFixturePdfBytes();
		const box = { left: 10, right: 100, top: 220, bottom: 200 };
		const quad = [box.left, box.top, box.right, box.top, box.left, box.bottom, box.right, box.bottom];
		const highlighted = await addHighlightAnnotation(bytes, {
			pageIndex: 0,
			quadPoints: quad,
			box,
			color: YELLOW,
			quote: 'the highlighted phrase',
		});

		const noted = await setHighlightNoteAt(highlighted, {
			pageIndex: 0,
			box: { left: 50, right: 50, top: 210, bottom: 210 },
			note: 'a study note',
		});
		expect(noted.updatedCount).toBe(1);

		expect((await getStoredQuotes(noted.bytes)).get(0)).toEqual(['the highlighted phrase']);
	});

	it('correctly separates a foreign highlight (no captured quote) from our own on the same page', async () => {
		// A highlight added without the `quote` option is indistinguishable from
		// one made by another tool (Adobe, Preview, another Obsidian plugin) --
		// same subtype, same shape, just missing our custom key. Real files
		// commonly mix both: a PDF someone already annotated in Adobe, then
		// highlighted further in this plugin. getStoredQuotes must keep the two
		// straight by position, not merge or misattribute them.
		const bytes = await makeFixturePdfBytes();
		const box1 = { left: 10, right: 100, top: 220, bottom: 200 };
		const quad1 = [box1.left, box1.top, box1.right, box1.top, box1.left, box1.bottom, box1.right, box1.bottom];
		const withForeign = await addHighlightAnnotation(bytes, { pageIndex: 0, quadPoints: quad1, box: box1, color: YELLOW });

		const box2 = { left: 10, right: 100, top: 150, bottom: 130 };
		const quad2 = [box2.left, box2.top, box2.right, box2.top, box2.left, box2.bottom, box2.right, box2.bottom];
		const withBoth = await addHighlightAnnotation(withForeign, {
			pageIndex: 0,
			quadPoints: quad2,
			box: box2,
			color: YELLOW,
			quote: 'made by this plugin',
		});

		const quotes = await getStoredQuotes(withBoth);
		expect(quotes.get(0)).toEqual([null, 'made by this plugin']);
	});
});

describe('removeHighlightsAt', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function countHighlights(bytes: Uint8Array, pageIndex: number): Promise<number> {
		const doc = await loadPdfjsDoc(bytes);
		const page = await doc.getPage(pageIndex + 1);
		const annotations = await page.getAnnotations();
		return annotations.filter((a: { subtype: string }) => a.subtype === 'Highlight').length;
	}

	it('removes only the highlight overlapping the given box, leaving others intact', async () => {
		const base = await makeFixturePdfBytes();
		const box1 = { left: 10, right: 100, top: 220, bottom: 200 };
		const quad1 = [box1.left, box1.top, box1.right, box1.top, box1.left, box1.bottom, box1.right, box1.bottom];
		const withFirst = await addHighlightAnnotation(base, { pageIndex: 0, quadPoints: quad1, box: box1, color: YELLOW });

		const box2 = { left: 10, right: 100, top: 150, bottom: 130 };
		const quad2 = [box2.left, box2.top, box2.right, box2.top, box2.left, box2.bottom, box2.right, box2.bottom];
		const withBoth = await addHighlightAnnotation(withFirst, { pageIndex: 0, quadPoints: quad2, box: box2, color: YELLOW });

		expect(await countHighlights(withBoth, 0)).toBe(2);

		// A selection box overlapping only the second highlight's region.
		const result = await removeHighlightsAt(withBoth, { pageIndex: 0, box: { left: 10, right: 100, top: 150, bottom: 130 } });

		expect(result.removedCount).toBe(1);
		expect(await countHighlights(result.bytes, 0)).toBe(1);

		// The survivor should be the first highlight, not the second.
		const doc = await loadPdfjsDoc(result.bytes);
		const page = await doc.getPage(1);
		const remaining = (await page.getAnnotations()).filter((a: { subtype: string }) => a.subtype === 'Highlight');
		expect(remaining[0].rect).toEqual([box1.left, box1.bottom, box1.right, box1.top]);
	});

	it('never removes non-Highlight annotations, even ones overlapping the box', async () => {
		const base = await makeFixturePdfBytes();
		const doc = await PDFDocument.load(base);
		const context = doc.context;
		const page = doc.getPage(0);
		const linkDict = context.obj({
			Type: 'Annot',
			Subtype: 'Link',
			Rect: [10, 130, 100, 220], // overlaps the box we'll pass to removeHighlightsAt
			Border: [0, 0, 0],
			A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.com') },
		});
		page.node.set(PDFName.of('Annots'), context.obj([context.register(linkDict)]));
		const bytesWithLink = await doc.save();

		const result = await removeHighlightsAt(bytesWithLink, {
			pageIndex: 0,
			box: { left: 10, right: 100, top: 220, bottom: 130 },
		});

		expect(result.removedCount).toBe(0);
		const afterDoc = await PDFDocument.load(result.bytes);
		const annots = afterDoc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
		expect(annots?.size()).toBe(1); // the Link annotation is untouched
	});

	it('is a no-op (and returns the original bytes) when nothing overlaps', async () => {
		const base = await makeFixturePdfBytes();
		const box = { left: 10, right: 100, top: 220, bottom: 200 };
		const quad = [box.left, box.top, box.right, box.top, box.left, box.bottom, box.right, box.bottom];
		const withHighlight = await addHighlightAnnotation(base, { pageIndex: 0, quadPoints: quad, box, color: YELLOW });

		const result = await removeHighlightsAt(withHighlight, {
			pageIndex: 0,
			box: { left: 500, right: 600, top: 50, bottom: 0 }, // far away, no overlap
		});

		expect(result.removedCount).toBe(0);
		expect(result.bytes).toBe(withHighlight); // same reference: genuinely a no-op
		expect(await countHighlights(result.bytes, 0)).toBe(1);
	});

	it('is a no-op when the page has no annotations at all', async () => {
		const base = await makeFixturePdfBytes();
		const result = await removeHighlightsAt(base, { pageIndex: 0, box: { left: 0, right: 100, top: 100, bottom: 0 } });
		expect(result.removedCount).toBe(0);
		expect(result.bytes).toBe(base);
	});

	it('removes a highlight from an owner-password-encrypted PDF', async () => {
		// Build encrypted bytes that already contain a highlight: highlight a
		// plain fixture, then re-encrypt the result.
		const box = { left: 10, right: 100, top: 220, bottom: 200 };
		const quad = [box.left, box.top, box.right, box.top, box.left, box.bottom, box.right, box.bottom];
		const highlighted = await addHighlightAnnotation(await makeFixturePdfBytes(), {
			pageIndex: 0,
			quadPoints: quad,
			box,
			color: YELLOW,
		});
		const doc = await PDFDocument.load(highlighted);
		doc.encrypt({ ownerPassword: 'owner-secret', permissions: { modifying: false } });
		const encrypted = await doc.save();
		await expect(PDFDocument.load(encrypted)).rejects.toThrow(EncryptedPDFError);

		const result = await removeHighlightsAt(encrypted, {
			pageIndex: 0,
			box: { left: 50, right: 50, top: 210, bottom: 210 },
		});
		expect(result.removedCount).toBe(1);
		expect(await countHighlights(result.bytes, 0)).toBe(0);
	});

	it('fails fast with a clear message on a PDF that genuinely requires a password to open', async () => {
		const bytes = await makeEncryptedFixturePdfBytes({ userPassword: 'open-secret' });
		await expect(
			removeHighlightsAt(bytes, { pageIndex: 0, box: { left: 0, right: 10, top: 10, bottom: 0 } }),
		).rejects.toThrow(/password/i);
	});
});

describe('hasHighlightAt', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('is true when a highlight overlaps the box, false otherwise', async () => {
		const base = await makeFixturePdfBytes();
		const box = { left: 10, right: 100, top: 220, bottom: 200 };
		const quad = [box.left, box.top, box.right, box.top, box.left, box.bottom, box.right, box.bottom];
		const withHighlight = await addHighlightAnnotation(base, { pageIndex: 0, quadPoints: quad, box, color: YELLOW });

		expect(await hasHighlightAt(withHighlight, { pageIndex: 0, box: { left: 50, right: 50, top: 210, bottom: 210 } })).toBe(true);
		expect(await hasHighlightAt(withHighlight, { pageIndex: 0, box: { left: 500, right: 500, top: 10, bottom: 10 } })).toBe(false);
	});

	it('is false on a page with no annotations at all (no error)', async () => {
		const base = await makeFixturePdfBytes();
		expect(await hasHighlightAt(base, { pageIndex: 0, box: { left: 0, right: 10, top: 10, bottom: 0 } })).toBe(false);
	});

	it('ignores non-Highlight annotations', async () => {
		const base = await makeFixturePdfBytes();
		const doc = await PDFDocument.load(base);
		const context = doc.context;
		const page = doc.getPage(0);
		const linkDict = context.obj({
			Type: 'Annot',
			Subtype: 'Link',
			Rect: [10, 130, 100, 220],
			Border: [0, 0, 0],
			A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.com') },
		});
		page.node.set(PDFName.of('Annots'), context.obj([context.register(linkDict)]));
		const bytesWithLink = await doc.save();

		expect(await hasHighlightAt(bytesWithLink, { pageIndex: 0, box: { left: 50, right: 50, top: 150, bottom: 150 } })).toBe(false);
	});

	it('does not modify the PDF (read-only)', async () => {
		const base = await makeFixturePdfBytes();
		await hasHighlightAt(base, { pageIndex: 0, box: { left: 0, right: 10, top: 10, bottom: 0 } });
		// base is a fresh Uint8Array from pdf-lib's own save(); if hasHighlightAt
		// mutated the loaded doc and (incorrectly) saved it back to this reference,
		// this would catch it. Since it never calls .save(), this just documents
		// the read-only contract explicitly rather than relying on code review.
		const doc = await PDFDocument.load(base);
		expect(doc.getPageCount()).toBe(1);
	});

	it('reads an owner-password-encrypted PDF without error', async () => {
		const bytes = await makeEncryptedFixturePdfBytes();
		expect(await hasHighlightAt(bytes, { pageIndex: 0, box: { left: 0, right: 10, top: 10, bottom: 0 } })).toBe(false);
	});
});

describe('highlight notes (annotation /Contents)', () => {
	const box = { left: 10, right: 100, top: 220, bottom: 200 };
	const quad = [box.left, box.top, box.right, box.top, box.left, box.bottom, box.right, box.bottom];
	const point = { left: 50, right: 50, top: 210, bottom: 210 };

	async function makeHighlightedBytes(): Promise<Uint8Array> {
		return addHighlightAnnotation(await makeFixturePdfBytes(), {
			pageIndex: 0,
			quadPoints: quad,
			box,
			color: YELLOW,
		});
	}

	it('sets a note that PDF.js (and Adobe) expose as the annotation comment, with unicode intact', async () => {
		const highlighted = await makeHighlightedBytes();
		const note = 'Repasar para el examen: cañón, café';
		const result = await setHighlightNoteAt(highlighted, { pageIndex: 0, box: point, note });
		expect(result.updatedCount).toBe(1);

		const pdfjsDoc = await loadPdfjsDoc(result.bytes);
		const page = await pdfjsDoc.getPage(1);
		const annots = await page.getAnnotations();
		expect(annots).toHaveLength(1);
		expect(annots[0].contentsObj.str).toBe(note);

		expect(await inspectHighlightAt(result.bytes, { pageIndex: 0, box: point })).toEqual({ note });
	});

	it('replaces an existing note when set again', async () => {
		const highlighted = await makeHighlightedBytes();
		const first = await setHighlightNoteAt(highlighted, { pageIndex: 0, box: point, note: 'first' });
		const second = await setHighlightNoteAt(first.bytes, { pageIndex: 0, box: point, note: 'second' });
		expect(second.updatedCount).toBe(1);
		expect(await inspectHighlightAt(second.bytes, { pageIndex: 0, box: point })).toEqual({ note: 'second' });
	});

	it('removes the note (but keeps the highlight) when set to empty/whitespace', async () => {
		const highlighted = await makeHighlightedBytes();
		const noted = await setHighlightNoteAt(highlighted, { pageIndex: 0, box: point, note: 'temp' });
		const cleared = await setHighlightNoteAt(noted.bytes, { pageIndex: 0, box: point, note: '   ' });
		expect(cleared.updatedCount).toBe(1);
		expect(await inspectHighlightAt(cleared.bytes, { pageIndex: 0, box: point })).toEqual({ note: null });
		expect(await hasHighlightAt(cleared.bytes, { pageIndex: 0, box: point })).toBe(true);
	});

	it('is a no-op (original bytes back) when no highlight is under the box', async () => {
		const base = await makeFixturePdfBytes();
		const result = await setHighlightNoteAt(base, { pageIndex: 0, box: point, note: 'nope' });
		expect(result.updatedCount).toBe(0);
		expect(result.bytes).toBe(base);
	});

	it('inspectHighlightAt: null when no highlight, note null when highlight has no note', async () => {
		const base = await makeFixturePdfBytes();
		expect(await inspectHighlightAt(base, { pageIndex: 0, box: point })).toBeNull();
		const highlighted = await makeHighlightedBytes();
		expect(await inspectHighlightAt(highlighted, { pageIndex: 0, box: point })).toEqual({ note: null });
	});

	it('fails fast with a clear message on a PDF that genuinely requires a password to open', async () => {
		const bytes = await makeEncryptedFixturePdfBytes({ userPassword: 'open-secret' });
		await expect(
			hasHighlightAt(bytes, { pageIndex: 0, box: { left: 0, right: 10, top: 10, bottom: 0 } }),
		).rejects.toThrow(/password/i);
	});
});
