// Pure logic for "Create flashcards from highlights": turns each highlight that
// has a note into a spaced-repetition card, with the note as the question and
// the highlighted text (plus a deep link back) as the answer.
//
// The merge converges: sync twice and the second run changes nothing, and the
// note always describes the highlights as they are now. The highlight's note is
// the source of truth, so editing a note in the PDF rewrites its card.
//
// What it must never do is regenerate the file wholesale, the way the exported
// highlights note does. obsidian-spaced-repetition stores each card's review
// schedule inline, on the line after the card (`<!--SR:!2026-08-14,7,250-->`),
// and binds it to the card by position -- so every edit here replaces a card's
// own lines and leaves its schedule line sitting right behind it. A card whose
// highlight is gone keeps both and moves to `## Orphaned` rather than being
// deleted: the highlight can come back (and then the card moves back), and
// review history is the one thing in this file the user can't recreate.
//
// Syntax constants match obsidian-spaced-repetition's defaults.

export const FLASHCARD_TAG = '#flashcards';
const SINGLE_LINE_SEPARATOR = '::';
const MULTI_LINE_SEPARATOR = '?';

/** Past this, a single-line card is unreadable during review. */
const MAX_SINGLE_LINE_LENGTH = 120;

export interface FlashcardSource {
	pageNumber: number;
	quote: string;
	note: string | null;
	/** Markdown link to the annotation, built by the caller. */
	link: string;
	/** The annotation subpath (`#page=1&annotation=12R`); identifies this card
	 * inside an existing note, since it survives in the answer's link. */
	key: string;
}

export interface FlashcardBlock {
	key: string;
	pageNumber: number;
	block: string;
}

/** Defuses the two sequences that would make the card split in the wrong
 * place: the single-line separator anywhere, and the multi-line separator
 * alone on a line. Deliberately does not touch `==`: it would become a cloze
 * under the plugin's default settings, but it is vanishingly rare in prose. */
export function neutralizeCardSyntax(text: string): string {
	return text
		.replace(/:{2,}/g, ':')
		.split('\n')
		.map((line) => (line.trim() === MULTI_LINE_SEPARATOR ? `${line.trim()}.` : line))
		.join('\n');
}

export function formatCard(source: FlashcardSource): string {
	const question = neutralizeCardSyntax((source.note ?? '').trim());
	const answer = `${neutralizeCardSyntax(source.quote)} — ${source.link}`;

	// Measured on what the user actually sees: the link markup is long but
	// renders as a short "p. N", so counting it would push ordinary cards into
	// the multi-line form for no reason.
	const renderedLength = question.length + source.quote.length;
	if (!question.includes('\n') && renderedLength <= MAX_SINGLE_LINE_LENGTH) {
		return `${question} ${SINGLE_LINE_SEPARATOR} ${answer}`;
	}
	return `${question}\n${MULTI_LINE_SEPARATOR}\n${answer}`;
}

/** Only highlights carrying a note become cards: the note is the question, and
 * inventing one from the quote alone would produce cards the user never wrote. */
export function buildFlashcardBlocks(sources: FlashcardSource[]): FlashcardBlock[] {
	return sources
		.filter((source) => (source.note ?? '').trim().length > 0)
		.map((source) => ({
			key: source.key,
			pageNumber: source.pageNumber,
			block: formatCard(source),
		}));
}

function pageHeading(pageNumber: number): string {
	return `## Page ${pageNumber}`;
}

export const ORPHAN_HEADING = '## Orphaned';

/** obsidian-spaced-repetition's inline schedule. Carried through every edit. */
const SCHEDULE_LINE = /^<!--SR:.*-->$/;

/** A blank-line-separated run of lines: one card (plus its schedule line), or a
 * paragraph the user wrote themselves. */
interface Chunk {
	lines: string[];
}

interface Section {
	/** null for the preamble above the first heading (the `#flashcards` tag). */
	heading: string | null;
	chunks: Chunk[];
}

function chunkText(chunk: Chunk): string {
	return chunk.lines.join('\n');
}

/** Splits a note into headed sections of blank-line-separated chunks. Blank
 * runs are not preserved verbatim -- rendering puts exactly one blank line
 * between chunks, which is the shape this file writes in the first place. */
function parseNote(content: string): Section[] {
	const sections: Section[] = [{ heading: null, chunks: [] }];
	let pending: string[] = [];

	const flush = () => {
		if (pending.length > 0) sections[sections.length - 1]!.chunks.push({ lines: pending });
		pending = [];
	};

	for (const line of content.split('\n')) {
		if (line.startsWith('## ')) {
			flush();
			sections.push({ heading: line.trim(), chunks: [] });
		} else if (line.trim() === '') {
			flush();
		} else {
			pending.push(line);
		}
	}
	flush();
	return sections;
}

function renderNote(sections: Section[]): string {
	const parts: string[] = [];
	for (const section of sections) {
		if (section.heading === null && section.chunks.length === 0) continue;
		if (section.heading !== null) parts.push(section.heading);
		for (const chunk of section.chunks) parts.push(chunkText(chunk));
	}
	return `${parts.join('\n\n')}\n`;
}

/** Identifies chunks this file wrote: card syntax plus an annotation link.
 * Used only to decide what may be moved to `## Orphaned`, so it deliberately
 * requires both -- a paragraph of the user's own that merely happens to quote
 * an annotation link is left where it is. Cards for highlights with no
 * annotation id (keyed by their quote instead) aren't recognised here and so
 * are never orphaned; they are simply left in place. */
function isOurCard(chunk: Chunk): boolean {
	const text = chunkText(chunk);
	const hasCardSyntax =
		text.includes(SINGLE_LINE_SEPARATOR) || chunk.lines.some((line) => line.trim() === MULTI_LINE_SEPARATOR);
	return hasCardSyntax && /annotation=[A-Za-z0-9]+/.test(text);
}

/** Replaces a card's own lines with new text, keeping its schedule line. */
function rewriteCard(chunk: Chunk, block: string): Chunk {
	const schedule = chunk.lines.filter((line) => SCHEDULE_LINE.test(line.trim()));
	return { lines: [...block.split('\n'), ...schedule] };
}

/** The section a card belongs in, created (in page order) if it isn't there.
 * `## Orphaned` always sorts last, so a real page never lands below it. */
function sectionFor(sections: Section[], heading: string): Section {
	const existing = sections.find((section) => section.heading === heading);
	if (existing) return existing;

	const created: Section = { heading, chunks: [] };
	const pageNumber = /^## Page (\d+)$/.exec(heading);
	const insertAt = sections.findIndex((section) => {
		if (section.heading === ORPHAN_HEADING) return true;
		const match = /^## Page (\d+)$/.exec(section.heading ?? '');
		return pageNumber !== null && match !== null && Number(match[1]) > Number(pageNumber[1]);
	});
	if (insertAt === -1) sections.push(created);
	else sections.splice(insertAt, 0, created);
	return created;
}

export interface FlashcardMergeResult {
	content: string;
	/** Cards written that were not in the note before. */
	added: number;
	/** Cards already present and already up to date. */
	kept: number;
	/** Cards whose highlight note changed, rewritten in place (schedule kept). */
	updated: number;
	/** Cards whose highlight (or note) is gone, moved to `## Orphaned`. */
	orphaned: number;
}

export function mergeFlashcardNote(
	existing: string | null,
	blocks: FlashcardBlock[],
): FlashcardMergeResult {
	const sections = parseNote(existing?.trim() ? existing : `${FLASHCARD_TAG}\n`);
	let added = 0;
	let kept = 0;
	let updated = 0;
	let orphaned = 0;

	/** Every card currently in the note, with where it sits. */
	const placed: { chunk: Chunk; section: Section }[] = [];
	for (const section of sections) {
		for (const chunk of section.chunks) {
			if (isOurCard(chunk)) placed.push({ chunk, section });
		}
	}

	const matched = new Set<Chunk>();

	for (const block of blocks) {
		const heading = pageHeading(block.pageNumber);
		const found = placed.find(({ chunk }) => chunkText(chunk).includes(block.key));

		if (!found) {
			sectionFor(sections, heading).chunks.push({ lines: block.block.split('\n') });
			added++;
			continue;
		}

		matched.add(found.chunk);
		const isCurrent = chunkText(found.chunk).startsWith(block.block);
		// A card sitting under `## Orphaned` whose highlight came back belongs in
		// its page section again -- that move is what makes an orphaning
		// reversible rather than a one-way trip.
		const misplaced = found.section.heading !== heading;

		if (isCurrent && !misplaced) {
			kept++;
			continue;
		}

		const rewritten = isCurrent ? found.chunk : rewriteCard(found.chunk, block.block);
		if (!isCurrent) updated++;
		else kept++;

		if (misplaced) {
			found.section.chunks = found.section.chunks.filter((chunk) => chunk !== found.chunk);
			sectionFor(sections, heading).chunks.push(rewritten);
		} else {
			// Rewrite where it stands: an edited note must not reshuffle the deck.
			const at = found.section.chunks.indexOf(found.chunk);
			found.section.chunks[at] = rewritten;
		}
	}

	for (const { chunk, section } of placed) {
		if (matched.has(chunk) || section.heading === ORPHAN_HEADING) continue;
		section.chunks = section.chunks.filter((existingChunk) => existingChunk !== chunk);
		sectionFor(sections, ORPHAN_HEADING).chunks.push(chunk);
		orphaned++;
	}

	// An emptied page section would otherwise leave a bare heading behind.
	const kept_sections = sections.filter((section) => section.heading === null || section.chunks.length > 0);

	return { content: renderNote(kept_sections), added, kept, updated, orphaned };
}
