import { describe, it, expect } from 'vitest';
import {
	EXPORT_BEGIN,
	EXPORT_END,
	annotationSubpath,
	buildEntryLink,
	sanitizeLinkAlias,
	colorSwatch,
	exportNotePath,
	formatQuoteBlock,
	formatExportBody,
	mergeExportedNote,
	type ExportEntry,
} from '../src/highlight-export';

const PALETTE = [
	{ name: 'Yellow', hex: '#ffff00' },
	{ name: 'Red', hex: '#ff0000' },
	{ name: 'Purple', hex: '#a22cff' },
];

const entry = (over: Partial<ExportEntry> = {}): ExportEntry => ({
	pageNumber: 1,
	quote: 'a quoted sentence',
	note: null,
	colorCss: 'rgb(255, 255, 0)',
	link: '[[book.pdf#page=1&annotation=40R|a quoted sentence]]',
	...over,
});

describe('sanitizeLinkAlias', () => {
	it('leaves ordinary text alone', () => {
		expect(sanitizeLinkAlias('the mitochondrion, in most cells')).toBe(
			'the mitochondrion, in most cells',
		);
	});

	it('strips the characters that would break a wikilink alias', () => {
		// A real quote: "as shown in [12] | table 3" would end the alias early
		// and leave stray markup in the note.
		expect(sanitizeLinkAlias('as shown in [12] | table 3')).toBe('as shown in 12 table 3');
	});

	it('collapses the whitespace left behind by stripping', () => {
		expect(sanitizeLinkAlias('see [ 12 ] here')).toBe('see 12 here');
	});

	it('strips the markdown-link characters too', () => {
		expect(sanitizeLinkAlias('a (parenthetical) aside')).toBe('a parenthetical aside');
	});

	it('returns an empty string when nothing survives', () => {
		expect(sanitizeLinkAlias('[|]')).toBe('');
	});
});

describe('exportNotePath', () => {
	it('puts the note beside the PDF', () => {
		expect(exportNotePath('Books/Biology', 'Cell')).toBe('Books/Biology/Cell (highlights).md');
	});

	it('does not produce a leading slash for a PDF in the vault root', () => {
		// Obsidian reports the root folder's path as '/', but vault paths are
		// relative -- '/Cell (highlights).md' would not resolve.
		expect(exportNotePath('/', 'Cell')).toBe('Cell (highlights).md');
		expect(exportNotePath('', 'Cell')).toBe('Cell (highlights).md');
		expect(exportNotePath(undefined, 'Cell')).toBe('Cell (highlights).md');
	});
});

describe('annotationSubpath', () => {
	it('targets the annotation when its id is known', () => {
		expect(annotationSubpath(3, '40R')).toBe('#page=3&annotation=40R');
	});

	it('falls back to the page when it is not', () => {
		expect(annotationSubpath(3, null)).toBe('#page=3');
	});
});

describe('buildEntryLink', () => {
	const generate = (subpath: string, alias: string) => `[[book.pdf${subpath}|${alias}]]`;

	it('uses the sanitized quote as the alias', () => {
		expect(
			buildEntryLink({ pageNumber: 2, quote: 'see [12] there', annotationId: '7R' }, generate),
		).toBe('[[book.pdf#page=2&annotation=7R|see 12 there]]');
	});

	it('falls back to the page when no text could be recovered', () => {
		// Scanned pages and foreign highlights often yield nothing.
		expect(buildEntryLink({ pageNumber: 5, quote: '', annotationId: null }, generate)).toBe(
			'[[book.pdf#page=5|p. 5]]',
		);
	});

	it('falls back to the page when sanitizing leaves nothing', () => {
		expect(buildEntryLink({ pageNumber: 5, quote: '[|]', annotationId: null }, generate)).toBe(
			'[[book.pdf#page=5|p. 5]]',
		);
	});
});

describe('colorSwatch', () => {
	it('names a palette color by exact match', () => {
		expect(colorSwatch('rgb(255, 255, 0)', PALETTE)).toBe('🟡');
		expect(colorSwatch('rgb(162, 44, 255)', PALETTE)).toBe('🟣');
	});

	it('gives no swatch to a color outside the palette', () => {
		// Highlights made in other readers are arbitrary colors; guessing the
		// nearest palette name would confidently mislabel them.
		expect(colorSwatch('rgb(255, 182, 193)', PALETTE)).toBeNull();
	});

	it('gives no swatch to an unparseable color', () => {
		expect(colorSwatch('', PALETTE)).toBeNull();
	});
});

describe('formatQuoteBlock', () => {
	it('quotes the head and leaves the note as a paragraph under it', () => {
		expect(formatQuoteBlock('some text', 'my thought')).toBe('> some text\n\nmy thought');
	});

	it('omits the note paragraph when there is no note', () => {
		expect(formatQuoteBlock('some text', null)).toBe('> some text');
	});

	it('keeps a multi-line note inside the quote block readable', () => {
		expect(formatQuoteBlock('some text', 'line one\nline two')).toBe(
			'> some text\n\nline one\nline two',
		);
	});
});

describe('formatExportBody', () => {
	const body = (entries: ExportEntry[]) =>
		formatExportBody(entries, { sourceLink: '[[book.pdf]]', palette: PALETTE });

	it('groups entries under a heading per page, in the order given', () => {
		const out = body([
			entry({ pageNumber: 1, link: '[[book.pdf#page=1|first]]' }),
			entry({ pageNumber: 4, link: '[[book.pdf#page=4|second]]' }),
			entry({ pageNumber: 4, link: '[[book.pdf#page=4|third]]' }),
		]);
		expect(out.match(/^## Page \d+$/gm)).toEqual(['## Page 1', '## Page 4']);
		expect(out.indexOf('second')).toBeLessThan(out.indexOf('third'));
	});

	it('renders the swatch and the link, and the note beneath', () => {
		const out = body([entry({ note: 'worth remembering' })]);
		expect(out).toContain('> 🟡 [[book.pdf#page=1&annotation=40R|a quoted sentence]]');
		expect(out).toContain('worth remembering');
	});

	it('drops the swatch for an off-palette color rather than inventing a name', () => {
		const out = body([entry({ colorCss: 'rgb(255, 182, 193)' })]);
		expect(out).toContain('> [[book.pdf#page=1&annotation=40R|a quoted sentence]]');
	});

	it('says the block is regenerated, so nobody edits inside it expecting it to last', () => {
		expect(body([entry()])).toMatch(/regenerated/i);
	});

	it('links back to the source PDF', () => {
		expect(body([entry()])).toContain('[[book.pdf]]');
	});

	it('says so plainly when the PDF has no highlights', () => {
		const out = body([]);
		expect(out).toMatch(/no highlights/i);
		expect(out).not.toContain('## Page');
	});
});

describe('mergeExportedNote', () => {
	const block = `${EXPORT_BEGIN}\nBODY\n${EXPORT_END}`;

	it('creates the note from nothing', () => {
		expect(mergeExportedNote(null, 'BODY')).toBe(`${block}\n`);
	});

	it('replaces only the managed block, keeping text on both sides', () => {
		const existing = `my own intro\n\n${EXPORT_BEGIN}\nOLD\n${EXPORT_END}\n\nmy own outro\n`;
		const merged = mergeExportedNote(existing, 'NEW');
		expect(merged).toBe(`my own intro\n\n${EXPORT_BEGIN}\nNEW\n${EXPORT_END}\n\nmy own outro\n`);
	});

	it('appends a block to a note that has none, without touching what is there', () => {
		const merged = mergeExportedNote('my own notes\n', 'BODY');
		expect(merged).toBe(`my own notes\n\n${block}\n`);
	});

	it('appends rather than cutting when the end marker is missing', () => {
		// The user deleted half the block by hand. Anything that "replaces to the
		// end" here destroys everything they wrote after it.
		const existing = `intro\n\n${EXPORT_BEGIN}\nOLD\n\nnotes I wrote after\n`;
		const merged = mergeExportedNote(existing, 'BODY');
		expect(merged).toContain('notes I wrote after');
		expect(merged).toContain('intro');
		expect(merged.endsWith(`${block}\n`)).toBe(true);
	});

	it('appends rather than cutting when the begin marker is missing', () => {
		const existing = `notes I wrote before\n${EXPORT_END}\nand after\n`;
		const merged = mergeExportedNote(existing, 'BODY');
		expect(merged).toContain('notes I wrote before');
		expect(merged).toContain('and after');
		expect(merged.endsWith(`${block}\n`)).toBe(true);
	});

	it('appends rather than cutting when the markers are in the wrong order', () => {
		const existing = `${EXPORT_END}\nmiddle\n${EXPORT_BEGIN}\n`;
		const merged = mergeExportedNote(existing, 'BODY');
		expect(merged).toContain('middle');
		expect(merged.endsWith(`${block}\n`)).toBe(true);
	});

	it('is idempotent: merging its own output changes nothing', () => {
		const once = mergeExportedNote('intro\n', 'BODY');
		expect(mergeExportedNote(once, 'BODY')).toBe(once);
	});

	it('replaces the first block only, if a copy-paste left two', () => {
		const existing = `${EXPORT_BEGIN}\nA\n${EXPORT_END}\n\n${EXPORT_BEGIN}\nB\n${EXPORT_END}\n`;
		const merged = mergeExportedNote(existing, 'NEW');
		expect(merged).toBe(`${EXPORT_BEGIN}\nNEW\n${EXPORT_END}\n\n${EXPORT_BEGIN}\nB\n${EXPORT_END}\n`);
	});
});
