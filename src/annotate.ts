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
	/** Any existing /Highlight annotation painting over this box is removed.
	 * Typically the box of the user's current text selection -- i.e. "remove
	 * whatever highlight is under this selected text." */
	box: PdfBox;
}

/** A /Highlight annotation reduced to the geometry a lookup needs: its /Rect
 * and the individual quads it actually paints. */
export interface HighlightGeometry {
	/** The annotation's /Rect -- the union of all quads. */
	box: PdfBox;
	/** One box per quad (one per highlighted line). Empty for a highlight with
	 * no usable /QuadPoints, where /Rect is all we have to go on. */
	quads: PdfBox[];
}

function numbersOf(array: PDFArray): number[] {
	return array.asArray().map((o) => (o as PDFNumber).asNumber());
}

/** The geometry of a /Highlight annotation, or null if the ref isn't one (or
 * has no /Rect). */
function readHighlightGeometry(context: PDFContext, ref: ReturnType<PDFArray['get']>): HighlightGeometry | null {
	const dict = context.lookup(ref, PDFDict);
	if (dict.get(PDFName.of('Subtype'))?.toString() !== '/Highlight') return null;

	const rectArray = context.lookupMaybe(dict.get(PDFName.of('Rect')), PDFArray);
	if (!rectArray) return null;
	const [left, bottom, right, top] = numbersOf(rectArray);
	const box = { left: left!, bottom: bottom!, right: right!, top: top! };

	const quadArray = context.lookupMaybe(dict.get(PDFName.of('QuadPoints')), PDFArray);
	const raw = quadArray ? numbersOf(quadArray) : [];
	const quads: PdfBox[] = [];
	// A malformed tail (length not a multiple of 8) is ignored rather than
	// guessed at; a highlight left with no usable quads falls back to /Rect.
	for (let i = 0; i + 8 <= raw.length; i += 8) {
		const xs = [raw[i]!, raw[i + 2]!, raw[i + 4]!, raw[i + 6]!];
		const ys = [raw[i + 1]!, raw[i + 3]!, raw[i + 5]!, raw[i + 7]!];
		quads.push({ left: Math.min(...xs), right: Math.max(...xs), top: Math.max(...ys), bottom: Math.min(...ys) });
	}

	return { box, quads };
}

/** True if box overlaps the area the highlight actually paints.
 *
 * Deliberately *not* a plain /Rect test. A highlight that wraps across lines
 * has a /Rect spanning the union of its lines, which also covers the blank
 * area beside a short last line -- so a neighbouring highlight starting there
 * (the next sentence, same line) sits entirely inside it. Matching on /Rect
 * made a click on one neighbour resolve to the other: the popup showed the
 * wrong note, and saving a note wrote it to both, which is what "two nearby
 * highlights share a note" looked like from the outside. Quads carry the real
 * per-line geometry, so they tell the two apart. */
function highlightMatchesBox(geometry: HighlightGeometry, box: PdfBox): boolean {
	if (geometry.quads.length === 0) return boxesOverlap(geometry.box, box);
	return geometry.quads.some((quad) => boxesOverlap(quad, box));
}

/** Painted area of a highlight, used to break ties when a point falls on more
 * than one (genuinely stacked highlights over the same words). The smallest
 * one wins: it's the more specific target, and the one a user pointing at
 * overlapping highlights means. */
function paintedArea(geometry: HighlightGeometry): number {
	const boxes = geometry.quads.length > 0 ? geometry.quads : [geometry.box];
	return boxes.reduce((sum, b) => sum + Math.max(0, b.right - b.left) * Math.max(0, b.top - b.bottom), 0);
}

/** The single highlight a click resolves to: the smallest match, or null.
 * Shared by every "which highlight is under this point" path so they cannot
 * disagree about the answer. */
function pickBestMatch<T extends { geometry: HighlightGeometry }>(candidates: T[], box: PdfBox): T | null {
	let best: T | null = null;
	let bestArea = Infinity;
	for (const candidate of candidates) {
		if (!highlightMatchesBox(candidate.geometry, box)) continue;
		const area = paintedArea(candidate.geometry);
		if (area < bestArea) {
			best = candidate;
			bestArea = area;
		}
	}
	return best;
}

/** True if the given annotation ref is a /Highlight painting over box. */
function isOverlappingHighlight(context: PDFContext, ref: ReturnType<PDFArray['get']>, box: PdfBox): boolean {
	const geometry = readHighlightGeometry(context, ref);
	return geometry !== null && highlightMatchesBox(geometry, box);
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

	const candidates: { geometry: HighlightGeometry; ref: ReturnType<PDFArray['get']> }[] = [];
	for (let i = 0; i < annots.size(); i++) {
		const ref = annots.get(i);
		const geometry = readHighlightGeometry(context, ref);
		if (geometry) candidates.push({ geometry, ref });
	}

	const best = pickBestMatch(candidates, box);
	return best ? { note: readNote(context.lookup(best.ref, PDFDict)) } : null;
}

/** Every /Highlight annotation on a page, in /Annots order, reduced to just
 * what a click lookup needs. */
export interface IndexedHighlight {
	/** The same geometry isOverlappingHighlight compares against. */
	geometry: HighlightGeometry;
	note: string | null;
}

/** All highlights in the document, keyed by 0-based page index. */
export type HighlightIndex = Map<number, IndexedHighlight[]>;

/** Parses the document once and reduces it to the boxes-and-notes a click
 * lookup needs, so repeated clicks don't each re-read and re-parse the whole
 * file (a real stall on a large PDF, on the tap path where it is most visible).
 *
 * Deliberately built from exactly what inspectHighlightAt inspects -- the
 * geometry and /Contents of each /Highlight, in /Annots order -- and resolved
 * by the same pickBestMatch, so a lookup against the index and a lookup
 * against the bytes cannot disagree. tests/annotate.test.ts pins that
 * equivalence. */
export async function buildHighlightIndex(pdfBytes: Uint8Array): Promise<HighlightIndex> {
	const pdfDoc = await loadPdfDoc(pdfBytes);
	const context = pdfDoc.context;
	const index: HighlightIndex = new Map();

	pdfDoc.getPages().forEach((page, pageIndex) => {
		const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
		if (!annots) return;

		const found: IndexedHighlight[] = [];
		for (let i = 0; i < annots.size(); i++) {
			const ref = annots.get(i);
			const geometry = readHighlightGeometry(context, ref);
			if (!geometry) continue;
			found.push({ geometry, note: readNote(context.lookup(ref, PDFDict)) });
		}
		if (found.length > 0) index.set(pageIndex, found);
	});

	return index;
}

/** The indexed equivalent of inspectHighlightAt: the highlight on the page the
 * given box resolves to, or null. */
export function findHighlightInIndex(index: HighlightIndex, options: RemoveHighlightsOptions): HighlightInfo | null {
	const { pageIndex, box } = options;
	const found = pickBestMatch(index.get(pageIndex) ?? [], box);
	return found ? { note: found.note } : null;
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

/** Sets (or clears) the /Contents comment on the *one* /Highlight annotation
 * the given box resolves to (see pickBestMatch). A note belongs to a single
 * highlight: this is only ever called with the point the user clicked, and
 * writing to every match instead meant a note typed on one highlight also
 * appeared on a neighbour it happened to overlap.
 *
 * /Contents is the standard place PDF viewers keep
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

	const candidates: { geometry: HighlightGeometry; ref: ReturnType<PDFArray['get']> }[] = [];
	for (let i = 0; i < annots.size(); i++) {
		const ref = annots.get(i);
		const geometry = readHighlightGeometry(context, ref);
		if (geometry) candidates.push({ geometry, ref });
	}

	const target = pickBestMatch(candidates, box);
	if (!target) {
		return { bytes: pdfBytes, updatedCount: 0 };
	}

	const dict = context.lookup(target.ref, PDFDict);
	if (trimmed) dict.set(PDFName.of('Contents'), PDFHexString.fromText(trimmed));
	else dict.delete(PDFName.of('Contents'));
	const updatedCount = 1;

	const savedBytes = await savePdfDoc(pdfDoc);
	await verifySavedBytes(savedBytes, pdfDoc.getPageCount(), pageIndex, annots.size());
	return { bytes: savedBytes, updatedCount };
}

/** Removes every /Highlight annotation on the page painting over the given box
 * -- "remove whatever my selection crosses", so unlike the note write this
 * stays all-matching. Other annotation types (links, form widgets, etc.) are
 * never touched. */
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
