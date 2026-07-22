// Test helper: builds a tiny in-memory PDF and loads it with pdfjs-dist so tests can
// get a *real* PDF.js PageViewport (with a genuine convertToPdfPoint) as their oracle,
// instead of a hand-reimplemented transform that could silently diverge from reality.
import { PDFDocument } from '@cantoo/pdf-lib';
import { fileURLToPath } from 'node:url';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- pdfjs-dist's legacy build ships .mjs with its own types; good enough for tests.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

// Points pdfjs at its bundled standard-font metrics so getTextContent() on
// non-embedded standard fonts doesn't warn about missing standardFontDataUrl.
const STANDARD_FONT_DATA_URL = fileURLToPath(
	new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url),
);

export const FIXTURE_PAGE_WIDTH = 400;
export const FIXTURE_PAGE_HEIGHT = 300;

export async function makeFixturePdfBytes(): Promise<Uint8Array> {
	const pdfDoc = await PDFDocument.create();
	pdfDoc.addPage([FIXTURE_PAGE_WIDTH, FIXTURE_PAGE_HEIGHT]);
	return pdfDoc.save();
}

/** Same tiny fixture, but encrypted. With no userPassword this mimics the
 * common "protected" textbook/scan: an owner password restricts permissions,
 * but the file opens in any viewer without prompting (user password is empty).
 * Pass a userPassword to make a document that genuinely requires a password. */
export async function makeEncryptedFixturePdfBytes(options: { userPassword?: string } = {}): Promise<Uint8Array> {
	const pdfDoc = await PDFDocument.create();
	pdfDoc.addPage([FIXTURE_PAGE_WIDTH, FIXTURE_PAGE_HEIGHT]);
	pdfDoc.encrypt({
		ownerPassword: 'owner-secret',
		...(options.userPassword ? { userPassword: options.userPassword } : {}),
		permissions: { modifying: false, annotating: false, copying: false },
	});
	return pdfDoc.save();
}

export async function loadFixturePage() {
	const bytes = await makeFixturePdfBytes();
	const doc = await loadPdfjsDoc(bytes);
	return doc.getPage(1);
}

export async function loadPdfjsDoc(bytes: Uint8Array) {
	// pdfjs-dist transfers/detaches the input buffer as an optimization (it becomes
	// zero-length after this call) -- always hand it a copy so callers can safely
	// keep using their original reference afterward.
	return pdfjsLib.getDocument({
		data: new Uint8Array(bytes),
		standardFontDataUrl: STANDARD_FONT_DATA_URL,
	}).promise;
}
