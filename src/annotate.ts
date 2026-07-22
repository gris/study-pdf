// Writes a standard PDF /Highlight annotation into a PDF's bytes using pdf-lib's
// low-level object API (pdf-lib has no high-level "addHighlight" helper). Validated
// against both PDF.js (Obsidian's engine) and macOS's native Quartz renderer during
// the initial spike (scripts preserved in git history under spike/).
// `@cantoo/pdf-lib` is an API-compatible fork of pdf-lib that adds real
// encryption support -- the one capability stock pdf-lib lacks that we need
// (see loadPdfDoc below).
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFNumber, PDFHexString, PDFInvalidObject, EncryptedPDFError, ParseSpeeds } from '@cantoo/pdf-lib';
import type { PDFContext } from '@cantoo/pdf-lib';
import { boxesOverlap, type PdfBox } from './geometry';

export interface RgbColor {
	/** 0..1 */
	r: number;
	/** 0..1 */
	g: number;
	/** 0..1 */
	b: number;
}

export interface AddHighlightOptions {
	/** 0-based page index. */
	pageIndex: number;
	/** Flat QuadPoints array, PDF32000 Z vertex order per quad, length a multiple of 8.
	 * One quad per line of a (possibly multi-line) selection. */
	quadPoints: number[];
	/** Union bounding box of all quads -- becomes the annotation's /Rect. */
	box: PdfBox;
	color: RgbColor;
	/** Fill opacity, 0..1. Defaults to full opacity: with the Multiply blend the
	 * highlight then renders over white paper as exactly its color while text
	 * stays readable -- the standard desktop-marker look. */
	opacity?: number;
	/** The exact text the user had selected when creating this highlight. PDF
	 * text layout doesn't support recovering "just the highlighted part" of a
	 * text run from geometry alone (see pdf-text-extraction.ts's extractQuote),
	 * so this is stored verbatim in a custom dict key and preferred over
	 * geometric reconstruction whenever it's available. */
	quote?: string;
}

const DEFAULT_OPACITY = 1;
/** Custom (non-spec) annotation dict key holding the quote captured at
 * creation time -- see AddHighlightOptions.quote. Conforming PDF readers
 * ignore dict keys they don't recognize, so this doesn't affect how the
 * highlight itself renders anywhere; only getStoredQuotes reads it back. */
const QUOTE_KEY = 'StudyPDFQuote';

interface LocalRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Converts each quad (8 numbers: TL,TR,BL,BR) into a rect local to the annotation's
 * own BBox coordinate space (BBox origin = box.left/box.bottom). One quad may not be
 * axis-aligned bounding-box-only in theory, but ours always are (see geometry.ts). */
function quadPointsToLocalRects(quadPoints: number[], box: PdfBox): LocalRect[] {
	const rects: LocalRect[] = [];
	for (let i = 0; i < quadPoints.length; i += 8) {
		const xs = [quadPoints[i], quadPoints[i + 2], quadPoints[i + 4], quadPoints[i + 6]] as number[];
		const ys = [quadPoints[i + 1], quadPoints[i + 3], quadPoints[i + 5], quadPoints[i + 7]] as number[];
		const left = Math.min(...xs);
		const right = Math.max(...xs);
		const bottom = Math.min(...ys);
		const top = Math.max(...ys);
		rects.push({
			x: left - box.left,
			y: bottom - box.bottom,
			width: right - left,
			height: top - bottom,
		});
	}
	return rects;
}

/** Builds the /AP appearance stream content: one filled rect per quad, combined into
 * a single fill operation so overlapping quads don't double up on opacity. An
 * appearance stream is what makes this render reliably across viewers (PDF.js in
 * particular won't reliably draw a highlight that only has QuadPoints/C, no /AP). */
function buildAppearanceStreamContent(quadPoints: number[], box: PdfBox, color: RgbColor): string {
	const rects = quadPointsToLocalRects(quadPoints, box);
	const lines = [
		'/GS0 gs',
		`${color.r} ${color.g} ${color.b} rg`,
		...rects.map((r) => `${r.x} ${r.y} ${r.width} ${r.height} re`),
		'f',
	];
	return lines.join('\n');
}

// Many real-world PDFs (scans, textbooks, downloaded books) are "encrypted" only
// to restrict printing/copying: an owner password sets permission flags, but the
// user password is empty, so every viewer opens them without prompting. Loading
// those with `password: ''` decrypts them (verified live on the user's actual
// 544-page course textbook). Note the output then SAVES DECRYPTED -- content
// identical, permission flags dropped. Only documents that genuinely require a
// password to open (a real user password, which we don't have) still fail, now
// with a clear message. (Stock pdf-lib had no decryption at all; that's why this
// module uses the @cantoo fork. Its `ignoreEncryption: true` is not a substitute:
// it just skips the guard and crashes deep in page-tree traversal.)
// parseSpeed Fastest disables pdf-lib's yield-to-event-loop throttling (its
// default is the *slowest* mode). Measured on a real 6MB/544-page textbook:
// 350ms -> 270ms per load -- and every operation loads at least twice (once to
// modify, once to verify). The main thread blocks for the duration, which is
// fine for a user-initiated action this short.
const PARSE_OPTS = { parseSpeed: ParseSpeeds.Fastest };

async function loadPdfDoc(pdfBytes: Uint8Array): Promise<PDFDocument> {
	try {
		return await PDFDocument.load(pdfBytes, PARSE_OPTS);
	} catch (err) {
		if (!(err instanceof EncryptedPDFError)) throw err;
		let doc: PDFDocument;
		try {
			doc = await PDFDocument.load(pdfBytes, { ...PARSE_OPTS, password: '' });
		} catch {
			throw new Error('This PDF requires a password to open, which this plugin does not support yet.');
		}
		// @cantoo/pdf-lib workarounds so a decrypting load always SAVES a genuinely
		// decrypted document (both confirmed empirically against its source):
		// 1. Its decrypting parser "decrypts" the original cross-reference stream
		//    too -- but xref streams are never encrypted, so that garbles them into
		//    PDFInvalidObjects, which the writer then re-serializes verbatim. The
		//    stale xref carries "/Encrypt N 0 R", making our saved output falsely
		//    (and unopenably) claim to still be encrypted. A fresh xref is always
		//    regenerated on save, so these leftovers are safe to drop.
		for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
			if (obj instanceof PDFInvalidObject) doc.context.delete(ref);
		}
		// 2. It only strips the trailer's /Encrypt entry when its legacy-crypto
		//    path sets context.isDecrypted; newer encryption revisions keep it.
		delete (doc.context.trailerInfo as { Encrypt?: unknown }).Encrypt;
		return doc;
	}
}

/** All saves go through here: force the classic cross-reference-table writer.
 * @cantoo/pdf-lib defaults to its object-stream writer for PDF 1.5+ headers, and
 * that writer produced corrupted output on a real decrypt-loaded textbook (the
 * freshly added annotation object was written truncated -- "End of file inside
 * dictionary" from PDF.js; confirmed with the vanilla library, not our
 * workarounds). The classic writer is the same one stock pdf-lib always used --
 * every output we validated across Adobe/Preview/PDF.js came from it. */
function savePdfDoc(pdfDoc: PDFDocument): Promise<Uint8Array> {
	// objectsPerTick Infinity: skip yield throttling, same rationale as
	// PARSE_OPTS (measured 130ms -> 20ms on the textbook).
	return pdfDoc.save({ useObjectStreams: false, objectsPerTick: Infinity });
}

/** Safety guard shared by every function that saves a modified PDF: pdf-lib fully
 * re-serializes the whole document on save, and complex real-world PDFs don't
 * always round-trip cleanly through that. Reload our own output and verify it
 * isn't structurally corrupted *before* ever handing these bytes to a caller who
 * may overwrite the user's original file with them. Fail loudly rather than
 * silently returning bad bytes. (Loaded-encrypted documents save decrypted --
 * verified empirically -- so this plain reload works for them too.) */
async function verifySavedBytes(
	savedBytes: Uint8Array,
	originalPageCount: number,
	pageIndex: number,
	expectedAnnotCount: number,
): Promise<void> {
	const verifyDoc = await PDFDocument.load(savedBytes, PARSE_OPTS);
	if (verifyDoc.getPageCount() !== originalPageCount) {
		throw new Error(
			`Study PDF: page count changed after saving (${originalPageCount} -> ${verifyDoc.getPageCount()}); aborting to avoid corrupting the file.`,
		);
	}
	const verifyAnnots = verifyDoc.getPage(pageIndex).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
	const verifyAnnotCount = verifyAnnots?.size() ?? 0;
	if (verifyAnnotCount !== expectedAnnotCount) {
		throw new Error(
			`Study PDF: annotation count on page ${pageIndex} is ${verifyAnnotCount}, expected ${expectedAnnotCount}; aborting to avoid corrupting the file.`,
		);
	}
}

export async function addHighlightAnnotation(
	pdfBytes: Uint8Array,
	options: AddHighlightOptions,
): Promise<Uint8Array> {
	const { pageIndex, quadPoints, box, color, opacity = DEFAULT_OPACITY, quote } = options;

	if (quadPoints.length === 0 || quadPoints.length % 8 !== 0) {
		throw new Error(`quadPoints must be a non-empty multiple of 8, got ${quadPoints.length}`);
	}

	const pdfDoc = await loadPdfDoc(pdfBytes);
	const page = pdfDoc.getPage(pageIndex);
	const context = pdfDoc.context;

	const width = box.right - box.left;
	const height = box.top - box.bottom;
	const apContent = buildAppearanceStreamContent(quadPoints, box, color);

	const apStream = context.stream(apContent, {
		Type: 'XObject',
		Subtype: 'Form',
		FormType: 1,
		BBox: [0, 0, width, height],
		Matrix: [1, 0, 0, 1, box.left, box.bottom],
		Resources: {
			ExtGState: {
				GS0: { Type: 'ExtGState', ca: opacity, BM: 'Multiply' },
			},
		},
	});
	const apRef = context.register(apStream);

	const highlightDict = context.obj({
		Type: 'Annot',
		Subtype: 'Highlight',
		Rect: [box.left, box.bottom, box.right, box.top],
		QuadPoints: quadPoints,
		C: [color.r, color.g, color.b],
		CA: opacity,
		F: 4, // Print flag: keeps the annotation visible/printable in all readers.
		AP: { N: apRef },
		...(quote?.trim() ? { [QUOTE_KEY]: PDFHexString.fromText(quote.trim()) } : {}),
	});
	const annotRef = context.register(highlightDict);

	const existingAnnots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
	const expectedAnnotCount = (existingAnnots?.size() ?? 0) + 1;
	const annots = existingAnnots ?? context.obj([]);
	annots.push(annotRef);
	page.node.set(PDFName.of('Annots'), annots);

	const savedBytes = await savePdfDoc(pdfDoc);
	await verifySavedBytes(savedBytes, pdfDoc.getPageCount(), pageIndex, expectedAnnotCount);
	return savedBytes;
}

export interface RemoveHighlightsOptions {
	/** 0-based page index. */
	pageIndex: number;
	/** Any existing /Highlight annotation whose Rect overlaps this box is removed.
	 * Typically the box of the user's current text selection -- i.e. "remove
	 * whatever highlight is under this selected text." */
	box: PdfBox;
}

/** True if the given annotation ref is a /Highlight whose Rect overlaps box. */
function isOverlappingHighlight(context: PDFContext, ref: ReturnType<PDFArray['get']>, box: PdfBox): boolean {
	const dict = context.lookup(ref, PDFDict);
	if (dict.get(PDFName.of('Subtype'))?.toString() !== '/Highlight') return false;

	const rectArray = context.lookupMaybe(dict.get(PDFName.of('Rect')), PDFArray);
	if (!rectArray) return false;

	const [left, bottom, right, top] = rectArray.asArray().map((o) => (o as PDFNumber).asNumber());
	return boxesOverlap({ left: left!, bottom: bottom!, right: right!, top: top! }, box);
}

export interface HighlightInfo {
	/** The annotation's /Contents comment (the "note"), or null if it has none. */
	note: string | null;
}

/** Reads a string-valued dict entry (by key name), handling both string
 * encodings a real-world PDF may use (literal PDFString and PDFHexString).
 * Used for both /Contents (the user's note) and the custom quote key. */
function readNote(dict: PDFDict, key = 'Contents'): string | null {
	const value = dict.get(PDFName.of(key));
	const text = (value as { decodeText?: () => string } | undefined)?.decodeText?.();
	return text || null;
}

/** Read-only lookup: the /Highlight annotation overlapping the given box, or
 * null if there is none. Used to decide what affordances to show on a click
 * (remove, add/edit note) without a full load-modify-save cycle. */
export async function inspectHighlightAt(
	pdfBytes: Uint8Array,
	options: RemoveHighlightsOptions,
): Promise<HighlightInfo | null> {
	const { pageIndex, box } = options;
	const pdfDoc = await loadPdfDoc(pdfBytes);
	const page = pdfDoc.getPage(pageIndex);
	const context = pdfDoc.context;

	const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
	if (!annots) return null;

	for (let i = 0; i < annots.size(); i++) {
		const ref = annots.get(i);
		if (isOverlappingHighlight(context, ref, box)) {
			return { note: readNote(context.lookup(ref, PDFDict)) };
		}
	}
	return null;
}

/** Read-only check: is there a /Highlight annotation on the page overlapping
 * the given box? */
export async function hasHighlightAt(pdfBytes: Uint8Array, options: RemoveHighlightsOptions): Promise<boolean> {
	return (await inspectHighlightAt(pdfBytes, options)) !== null;
}

/** Every /Highlight annotation's captured-at-creation quote (see
 * AddHighlightOptions.quote), keyed by 0-based page index, in the same
 * per-page order as pdf.js's own getAnnotations() filtered to
 * subtype === 'Highlight' -- both walk the same /Annots array in creation
 * order, and our own highlights never set flags (Hidden/NoView) that would
 * make pdf.js skip one, so callers can zip the two lists by index. A custom
 * dict key isn't visible through pdf.js's own annotation API (it strips
 * dicts down to its known schema -- verified directly), which is why this
 * reads the raw bytes instead of going through the live pdf.js document.
 * null entries mean no captured quote (a highlight from another tool, or
 * one made before this feature existed) -- callers should fall back to
 * geometric reconstruction (extractQuote in pdf-text-extraction.ts) for
 * those. */
export async function getStoredQuotes(pdfBytes: Uint8Array): Promise<Map<number, (string | null)[]>> {
	const pdfDoc = await loadPdfDoc(pdfBytes);
	const context = pdfDoc.context;
	const result = new Map<number, (string | null)[]>();

	for (let pageIndex = 0; pageIndex < pdfDoc.getPageCount(); pageIndex++) {
		const annots = pdfDoc.getPage(pageIndex).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
		if (!annots) continue;

		const quotes: (string | null)[] = [];
		for (let i = 0; i < annots.size(); i++) {
			const dict = context.lookup(annots.get(i), PDFDict);
			if (dict.get(PDFName.of('Subtype'))?.toString() !== '/Highlight') continue;
			quotes.push(readNote(dict, QUOTE_KEY));
		}
		if (quotes.length > 0) result.set(pageIndex, quotes);
	}
	return result;
}

export interface SetNoteOptions extends RemoveHighlightsOptions {
	/** The note text. Empty/whitespace-only removes the note (the highlight
	 * itself is untouched). */
	note: string;
}

/** Sets (or clears) the /Contents comment on every /Highlight annotation
 * overlapping the given box. /Contents is the standard place PDF viewers keep
 * an annotation's comment, so the note travels with the file and shows up in
 * Adobe/Preview popups too. Stored as a PDFHexString (UTF-16BE) so non-ASCII
 * text -- accents, ñ -- round-trips intact. */
export async function setHighlightNoteAt(
	pdfBytes: Uint8Array,
	options: SetNoteOptions,
): Promise<{ bytes: Uint8Array; updatedCount: number }> {
	const { pageIndex, box, note } = options;
	const trimmed = note.trim();

	const pdfDoc = await loadPdfDoc(pdfBytes);
	const page = pdfDoc.getPage(pageIndex);
	const context = pdfDoc.context;

	const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
	if (!annots || annots.size() === 0) {
		return { bytes: pdfBytes, updatedCount: 0 };
	}

	let updatedCount = 0;
	for (let i = 0; i < annots.size(); i++) {
		const ref = annots.get(i);
		if (!isOverlappingHighlight(context, ref, box)) continue;
		const dict = context.lookup(ref, PDFDict);
		if (trimmed) dict.set(PDFName.of('Contents'), PDFHexString.fromText(trimmed));
		else dict.delete(PDFName.of('Contents'));
		updatedCount++;
	}

	if (updatedCount === 0) {
		return { bytes: pdfBytes, updatedCount: 0 };
	}

	const savedBytes = await savePdfDoc(pdfDoc);
	await verifySavedBytes(savedBytes, pdfDoc.getPageCount(), pageIndex, annots.size());
	return { bytes: savedBytes, updatedCount };
}

/** Removes every /Highlight annotation on the page whose Rect overlaps the given
 * box. Other annotation types (links, form widgets, etc.) are never touched. */
export async function removeHighlightsAt(
	pdfBytes: Uint8Array,
	options: RemoveHighlightsOptions,
): Promise<{ bytes: Uint8Array; removedCount: number }> {
	const { pageIndex, box } = options;

	const pdfDoc = await loadPdfDoc(pdfBytes);
	const page = pdfDoc.getPage(pageIndex);
	const context = pdfDoc.context;

	const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
	if (!annots || annots.size() === 0) {
		return { bytes: pdfBytes, removedCount: 0 };
	}

	const keptRefs: ReturnType<PDFArray['get']>[] = [];
	let removedCount = 0;
	for (let i = 0; i < annots.size(); i++) {
		const ref = annots.get(i);
		if (isOverlappingHighlight(context, ref, box)) {
			removedCount++;
			continue; // drop this ref -- don't add it to keptRefs
		}
		keptRefs.push(ref);
	}

	if (removedCount === 0) {
		return { bytes: pdfBytes, removedCount: 0 };
	}

	const newAnnots = PDFArray.withContext(context);
	for (const ref of keptRefs) newAnnots.push(ref);
	page.node.set(PDFName.of('Annots'), newAnnots);

	const expectedAnnotCount = keptRefs.length;
	const savedBytes = await savePdfDoc(pdfDoc);
	await verifySavedBytes(savedBytes, pdfDoc.getPageCount(), pageIndex, expectedAnnotCount);
	return { bytes: savedBytes, removedCount };
}
