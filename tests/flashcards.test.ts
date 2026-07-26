import { describe, it, expect } from 'vitest';
import {
	FLASHCARD_TAG,
	buildFlashcardBlocks,
	formatCard,
	mergeFlashcardNote,
	neutralizeCardSyntax,
	type FlashcardSource,
} from '../src/flashcards';

const source = (over: Partial<FlashcardSource> = {}): FlashcardSource => ({
	pageNumber: 1,
	quote: 'the zone of proximal development',
	note: 'What did Vygotsky call the gap between assisted and solo performance?',
	link: '[[book.pdf#page=1&annotation=12R|p. 1]]',
	key: '#page=1&annotation=12R',
	...over,
});

describe('neutralizeCardSyntax', () => {
	it('leaves ordinary text alone', () => {
		expect(neutralizeCardSyntax('a normal note about Piaget')).toBe('a normal note about Piaget');
	});

	it('collapses a stray :: so it cannot split the card', () => {
		// '::' is the single-line separator: left in the question, it would make
		// the card break in the wrong place.
		expect(neutralizeCardSyntax('see chapter 2 :: page 40')).toBe('see chapter 2 : page 40');
		expect(neutralizeCardSyntax('a:::b')).toBe('a:b');
	});

	it('defuses a line that is only a question mark', () => {
		// That is the multi-line separator; a bare '?' line inside the question
		// would end it early.
		expect(neutralizeCardSyntax('really\n?\nyes')).toBe('really\n?.\nyes');
	});

	it('leaves question marks that are part of a sentence', () => {
		expect(neutralizeCardSyntax('what is it?\nno idea')).toBe('what is it?\nno idea');
	});
});

describe('formatCard', () => {
	it('uses the single-line form for a short one-line note', () => {
		expect(formatCard(source())).toBe(
			'What did Vygotsky call the gap between assisted and solo performance? :: ' +
				'the zone of proximal development — [[book.pdf#page=1&annotation=12R|p. 1]]',
		);
	});

	it('uses the multi-line form when the note has its own line breaks', () => {
		const card = formatCard(source({ note: 'first line\nsecond line' }));
		expect(card).toBe(
			'first line\nsecond line\n?\n' +
				'the zone of proximal development — [[book.pdf#page=1&annotation=12R|p. 1]]',
		);
	});

	it('uses the multi-line form when one line would be unreadably long', () => {
		const card = formatCard(source({ note: 'q'.repeat(80), quote: 'a'.repeat(80) }));
		expect(card).toContain('\n?\n');
		expect(card).not.toContain(' :: ');
	});

	it('neutralizes card syntax coming from the note or the quote', () => {
		const card = formatCard(source({ note: 'compare :: contrast', quote: 'a :: b' }));
		expect(card.match(/::/g)).toHaveLength(1); // only the separator itself
	});
});

describe('buildFlashcardBlocks', () => {
	it('makes a card only for highlights that have a note', () => {
		const blocks = buildFlashcardBlocks([
			source({ note: 'a real question?' }),
			source({ note: null, key: '#page=1&annotation=14R' }),
			source({ note: '   ', key: '#page=1&annotation=16R' }),
		]);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]!.key).toBe('#page=1&annotation=12R');
	});

	it('keeps the page number so cards can be filed under their heading', () => {
		const blocks = buildFlashcardBlocks([source({ pageNumber: 7 })]);
		expect(blocks[0]!.pageNumber).toBe(7);
	});
});

describe('mergeFlashcardNote', () => {
	const block = (key: string, text: string, pageNumber = 1) => ({ key, block: text, pageNumber });

	it('creates the note with the flashcard tag when there is none', () => {
		const out = mergeFlashcardNote(null, [block('#page=1&annotation=12R', 'Q :: A [[x#page=1&annotation=12R|p. 1]]')]);
		expect(out.content.startsWith(`${FLASHCARD_TAG}\n`)).toBe(true);
		expect(out.content).toContain('## Page 1');
		expect(out.content).toContain('Q :: A');
		expect(out.added).toBe(1);
	});

	it('never rewrites an existing card or its review schedule', () => {
		// The whole point: spaced repetition stores scheduling inline, and
		// regenerating the file would reset every card the user has studied.
		const existing = [
			FLASHCARD_TAG,
			'',
			'## Page 1',
			'',
			'Old question :: Old answer [[x#page=1&annotation=12R|p. 1]]',
			'<!--SR:!2026-08-14,7,250-->',
			'',
		].join('\n');
		const out = mergeFlashcardNote(existing, [
			block('#page=1&annotation=12R', 'Old question :: Old answer [[x#page=1&annotation=12R|p. 1]]'),
		]);
		expect(out.content).toBe(existing);
		expect(out.added).toBe(0);
		expect(out.kept).toBe(1);
	});

	it('appends a genuinely new card under its page heading', () => {
		const existing = [
			FLASHCARD_TAG,
			'',
			'## Page 1',
			'',
			'First :: Answer [[x#page=1&annotation=12R|p. 1]]',
			'<!--SR:!2026-08-14,7,250-->',
			'',
			'## Page 4',
			'',
			'Other :: Answer [[x#page=4&annotation=20R|p. 4]]',
			'',
		].join('\n');
		const out = mergeFlashcardNote(existing, [
			block('#page=1&annotation=12R', 'First :: Answer [[x#page=1&annotation=12R|p. 1]]'),
			block('#page=1&annotation=14R', 'Second :: Answer [[x#page=1&annotation=14R|p. 1]]'),
			// Still highlighted, so it stays where it is rather than orphaning.
			block('#page=4&annotation=20R', 'Other :: Answer [[x#page=4&annotation=20R|p. 4]]', 4),
		]);
		expect(out.added).toBe(1);
		expect(out.content).toContain('<!--SR:!2026-08-14,7,250-->');
		// Filed under Page 1, not dumped at the end after Page 4.
		expect(out.content.indexOf('Second ::')).toBeLessThan(out.content.indexOf('## Page 4'));
	});

	it('adds a heading for a page the note does not have yet', () => {
		const existing = `${FLASHCARD_TAG}\n\n## Page 1\n\nFirst :: A [[x#page=1&annotation=12R|p. 1]]\n`;
		const out = mergeFlashcardNote(existing, [
			block('#page=1&annotation=12R', 'First :: A [[x#page=1&annotation=12R|p. 1]]'),
			block('#page=9&annotation=30R', 'New :: A [[x#page=9&annotation=30R|p. 9]]', 9),
		]);
		expect(out.content).toContain('## Page 9');
		expect(out.content.trimEnd().endsWith('New :: A [[x#page=9&annotation=30R|p. 9]]')).toBe(true);
	});

	it('files a new page section in page order, not at the end', () => {
		// Cards for an earlier page can be added later (the user noted page 2
		// first). Existing lines still move as a block, never rewritten.
		const existing = `${FLASHCARD_TAG}\n\n## Page 2\n\nB :: A [[x#page=2&annotation=18R|p. 2]]\n<!--SR:!2026-08-14,7,250-->\n`;
		const out = mergeFlashcardNote(existing, [
			block('#page=1&annotation=12R', 'A :: A [[x#page=1&annotation=12R|p. 1]]', 1),
			block('#page=2&annotation=18R', 'B :: A [[x#page=2&annotation=18R|p. 2]]', 2),
		]);
		expect(out.content.indexOf('## Page 1')).toBeLessThan(out.content.indexOf('## Page 2'));
		expect(out.content).toContain('<!--SR:!2026-08-14,7,250-->');
	});

	it('is idempotent: syncing the same cards twice changes nothing', () => {
		const cards = [block('#page=1&annotation=12R', 'Q :: A [[x#page=1&annotation=12R|p. 1]]')];
		const once = mergeFlashcardNote(null, cards);
		const twice = mergeFlashcardNote(once.content, cards);
		expect(twice.content).toBe(once.content);
		expect(twice.added).toBe(0);
	});

	it('leaves anything the user wrote in the file untouched', () => {
		const existing = `${FLASHCARD_TAG}\n\nMy own revision plan.\n\n## Page 1\n\nQ :: A [[x#page=1&annotation=12R|p. 1]]\n`;
		const out = mergeFlashcardNote(existing, [
			block('#page=1&annotation=12R', 'Q :: A [[x#page=1&annotation=12R|p. 1]]'),
			block('#page=1&annotation=14R', 'New :: A [[x#page=1&annotation=14R|p. 1]]'),
		]);
		expect(out.content).toContain('My own revision plan.');
		expect(out.content).toContain('Q :: A');
	});

	it('rewrites a card whose highlight note changed, keeping its review schedule', () => {
		// The PDF note is the source of truth. The schedule comment is positional --
		// obsidian-spaced-repetition reads the <!--SR:...--> line that follows the
		// card -- so replacing the card's own lines and leaving that line in place
		// keeps the review history attached.
		const existing = `${FLASHCARD_TAG}\n\n## Page 1\n\nOld :: A [[x#page=1&annotation=12R|p. 1]]\n<!--SR:!2026-08-14,7,250-->\n`;
		const out = mergeFlashcardNote(existing, [
			block('#page=1&annotation=12R', 'New wording :: A [[x#page=1&annotation=12R|p. 1]]'),
		]);

		expect(out.updated).toBe(1);
		expect(out.content).toContain('New wording :: A');
		expect(out.content).not.toContain('Old :: A');
		expect(out.content).toContain('<!--SR:!2026-08-14,7,250-->');
		// Still directly after its card, or the schedule belongs to nothing.
		expect(out.content).toContain('New wording :: A [[x#page=1&annotation=12R|p. 1]]\n<!--SR:!2026-08-14,7,250-->');
	});

	it('rewrites a card where it stands, without reshuffling the section', () => {
		const existing = [
			FLASHCARD_TAG,
			'',
			'## Page 1',
			'',
			'First :: A [[x#page=1&annotation=12R|p. 1]]',
			'',
			'Second :: A [[x#page=1&annotation=14R|p. 1]]',
			'',
		].join('\n');
		const out = mergeFlashcardNote(existing, [
			block('#page=1&annotation=12R', 'First edited :: A [[x#page=1&annotation=12R|p. 1]]'),
			block('#page=1&annotation=14R', 'Second :: A [[x#page=1&annotation=14R|p. 1]]'),
		]);

		expect(out.updated).toBe(1);
		expect(out.content.indexOf('First edited ::')).toBeLessThan(out.content.indexOf('Second ::'));
	});

	it('moves a card whose highlight is gone to an Orphaned section, schedule intact', () => {
		const existing = [
			FLASHCARD_TAG,
			'',
			'## Page 1',
			'',
			'Gone :: A [[x#page=1&annotation=99R|p. 1]]',
			'<!--SR:!2026-08-14,7,250-->',
			'',
			'Kept :: A [[x#page=1&annotation=12R|p. 1]]',
			'',
		].join('\n');
		const out = mergeFlashcardNote(existing, [
			block('#page=1&annotation=12R', 'Kept :: A [[x#page=1&annotation=12R|p. 1]]'),
		]);

		expect(out.orphaned).toBe(1);
		expect(out.content).toContain('## Orphaned');
		expect(out.content.indexOf('Gone ::')).toBeGreaterThan(out.content.indexOf('## Orphaned'));
		expect(out.content).toContain('<!--SR:!2026-08-14,7,250-->');
		// The surviving card stays under its page heading.
		expect(out.content.indexOf('Kept ::')).toBeLessThan(out.content.indexOf('## Orphaned'));
	});

	it('brings an orphaned card back when its highlight returns', () => {
		const existing = [
			FLASHCARD_TAG,
			'',
			'## Page 1',
			'',
			'Other :: A [[x#page=1&annotation=12R|p. 1]]',
			'',
			'## Orphaned',
			'',
			'Back :: A [[x#page=1&annotation=14R|p. 1]]',
			'<!--SR:!2026-08-14,7,250-->',
			'',
		].join('\n');
		const out = mergeFlashcardNote(existing, [
			block('#page=1&annotation=12R', 'Other :: A [[x#page=1&annotation=12R|p. 1]]'),
			block('#page=1&annotation=14R', 'Back :: A [[x#page=1&annotation=14R|p. 1]]'),
		]);

		expect(out.orphaned).toBe(0);
		expect(out.content.indexOf('Back ::')).toBeLessThan(out.content.indexOf('## Orphaned') === -1 ? Infinity : out.content.indexOf('## Orphaned'));
		expect(out.content).toContain('<!--SR:!2026-08-14,7,250-->');
	});

	it('converges: a second sync after any change is a no-op', () => {
		const first = mergeFlashcardNote(null, [
			block('#page=1&annotation=12R', 'Q :: A [[x#page=1&annotation=12R|p. 1]]'),
			block('#page=2&annotation=14R', 'Q2 :: A [[x#page=2&annotation=14R|p. 2]]', 2),
		]);
		// The note changed on one card and the other highlight was deleted.
		const changed = [block('#page=1&annotation=12R', 'Q edited :: A [[x#page=1&annotation=12R|p. 1]]')];
		const second = mergeFlashcardNote(first.content, changed);
		const third = mergeFlashcardNote(second.content, changed);

		expect(second.updated).toBe(1);
		expect(second.orphaned).toBe(1);
		expect(third.content).toBe(second.content);
		expect(third).toMatchObject({ added: 0, updated: 0, orphaned: 0 });
	});
});
