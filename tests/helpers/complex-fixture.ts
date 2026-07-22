// A deterministic, offline stand-in for a "complex real-world PDF": multiple pages,
// a pre-existing non-highlight annotation, and an AcroForm field. Used to test that
// writing a highlight via pdf-lib's full-document re-serialization doesn't drop or
// corrupt content it wasn't asked to touch -- the data-safety risk named in the plan
// (a tiny single-page fixture would never surface that class of bug).
import { PDFDocument, PDFName, PDFArray, PDFString, StandardFonts, rgb } from '@cantoo/pdf-lib';

export const COMPLEX_FIXTURE_PAGE_COUNT = 3;
export const LINK_ANNOTATION_URI = 'https://example.com/pre-existing-link';
export const FORM_FIELD_NAME = 'pre.existing.field';
export const FORM_FIELD_VALUE = 'original value, must survive';
export const PAGE_2_TEXT = 'This text on page 3 must survive untouched.';

export async function makeComplexFixturePdfBytes(): Promise<Uint8Array> {
	const pdfDoc = await PDFDocument.create();
	const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

	const page0 = pdfDoc.addPage([400, 300]);
	const page1 = pdfDoc.addPage([400, 300]);
	const page2 = pdfDoc.addPage([400, 300]);

	page0.drawText('Page 1: has a link annotation and a form field.', {
		x: 20, y: 250, size: 12, font, color: rgb(0, 0, 0),
	});
	page1.drawText('Page 2: this text will be highlighted.', {
		x: 20, y: 250, size: 12, font, color: rgb(0, 0, 0),
	});
	page2.drawText(PAGE_2_TEXT, { x: 20, y: 250, size: 12, font, color: rgb(0, 0, 0) });

	// Pre-existing non-highlight annotation (a Link), constructed at the same
	// low level our own annotate.ts uses, so it's a realistic peer object.
	const context = pdfDoc.context;
	const linkDict = context.obj({
		Type: 'Annot',
		Subtype: 'Link',
		Rect: [20, 230, 200, 245],
		Border: [0, 0, 0],
		A: {
			Type: 'Action',
			S: 'URI',
			URI: PDFString.of(LINK_ANNOTATION_URI),
		},
	});
	const linkRef = context.register(linkDict);
	page0.node.set(PDFName.of('Annots'), context.obj([linkRef]));

	// AcroForm text field, to exercise the forms path through a full re-save.
	const form = pdfDoc.getForm();
	const field = form.createTextField(FORM_FIELD_NAME);
	field.setText(FORM_FIELD_VALUE);
	field.addToPage(page0, { x: 20, y: 200, width: 150, height: 20 });

	return pdfDoc.save();
}

/** Reads back the pieces of the complex fixture that a highlight-writing round-trip
 * must not disturb, for before/after comparison in tests. */
export async function inspectComplexFixture(bytes: Uint8Array) {
	const pdfDoc = await PDFDocument.load(bytes);
	const pageCount = pdfDoc.getPageCount();

	const page0 = pdfDoc.getPage(0);
	const annots = page0.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
	const linkUris: string[] = [];
	if (annots) {
		for (let i = 0; i < annots.size(); i++) {
			const dict = pdfDoc.context.lookup(annots.get(i));
			// Only PDFDict-like objects have .get(); skip anything else defensively.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const d = dict as any;
			if (d?.get && d.get(PDFName.of('Subtype'))?.toString() === '/Link') {
				const action = pdfDoc.context.lookup(d.get(PDFName.of('A')));
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const uri = (action as any)?.get(PDFName.of('URI'));
				linkUris.push(uri?.decodeText?.() ?? String(uri));
			}
		}
	}

	const form = pdfDoc.getForm();
	const field = form.getTextField(FORM_FIELD_NAME);
	const fieldValue = field.getText();

	return { pageCount, linkUris, fieldValue };
}
