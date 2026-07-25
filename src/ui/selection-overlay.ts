// Paints the current text selection ourselves, as real DOM rectangles.
//
// Only needed on iOS: WKWebView ignores every ::selection property inside the
// PDF text layer (background-color, color and -webkit-text-fill-color were all
// confirmed dead on-device at the highest specificity in the cascade) and paints
// its own very faint system tint instead, which is close to invisible over white
// paper. CodeMirror has the same problem in the editor and solves it the same
// way, which is why notes look stronger than PDFs on an iPhone.
//
// Deliberately dumb: it owns no selection state of its own, it just renders
// whatever rectangles it is handed. Deciding *when* to show them stays in
// main.ts alongside the rest of the selection logic.

/** A viewport-space rectangle to paint. Structural, not a DOMRect, so callers
 * can hand over plain objects and tests don't need a DOM. */
export interface OverlayRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface SelectionOverlay {
	/** Replaces whatever is currently painted. An empty list clears it. */
	update(rects: OverlayRect[]): void;
	/** Removes the overlay element entirely. */
	destroy(): void;
}

/** How much two rects must overlap vertically, as a fraction of the shorter
 * one, to count as the same line of text. Rects on one line routinely differ in
 * top and height by a few pixels when a line mixes font sizes (superscript
 * footnote markers, small caps), so exact comparison leaves them unmerged --
 * measured on a real page before this was a ratio. Consecutive lines overlap far
 * less than half, so this separates them cleanly. */
const SAME_LINE_OVERLAP = 0.5;

/** Drops zero-area rectangles and unions ones that sit on the same line and
 * touch. getClientRects() returns one rect per line box, but on a PDF text layer
 * it also returns slivers for inter-word gaps and overlapping rects where
 * adjacent spans abut -- painted at partial opacity those show up as seams and
 * double-darkened patches along an otherwise even line. */
export function normalizeOverlayRects(rects: OverlayRect[]): OverlayRect[] {
	const usable = rects.filter((r) => r.width >= 1 && r.height >= 1);
	const out: OverlayRect[] = [];
	for (const rect of usable) {
		const merged = out.find((o) => onSameLine(o, rect) && touchesHorizontally(o, rect));
		if (!merged) {
			out.push({ ...rect });
			continue;
		}
		const left = Math.min(merged.left, rect.left);
		const top = Math.min(merged.top, rect.top);
		merged.width = Math.max(merged.left + merged.width, rect.left + rect.width) - left;
		merged.height = Math.max(merged.top + merged.height, rect.top + rect.height) - top;
		merged.left = left;
		merged.top = top;
	}
	return out;
}

function onSameLine(a: OverlayRect, b: OverlayRect): boolean {
	const overlap = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
	return overlap > 0 && overlap >= Math.min(a.height, b.height) * SAME_LINE_OVERLAP;
}

/** Touching counts as overlapping: abutting spans leave no gap, and a 1px slack
 * absorbs the sub-pixel seams that fractional zoom levels produce. */
function touchesHorizontally(a: OverlayRect, b: OverlayRect): boolean {
	return b.left <= a.left + a.width + 1 && a.left <= b.left + b.width + 1;
}

export function createSelectionOverlay(doc: Document): SelectionOverlay {
	const el = doc.body.createDiv({ cls: 'study-pdf-selection-overlay' });
	return {
		update(rects: OverlayRect[]) {
			el.empty();
			for (const rect of normalizeOverlayRects(rects)) {
				const rectEl = el.createDiv({ cls: 'study-pdf-selection-rect' });
				rectEl.setCssStyles({
					left: `${rect.left}px`,
					top: `${rect.top}px`,
					width: `${rect.width}px`,
					height: `${rect.height}px`,
				});
			}
		},
		destroy() {
			el.remove();
		},
	};
}
