// Decides whether a touch that the browser *cancelled* was really a tap.
//
// iOS/WKWebView fires `pointercancel` instead of `pointerup` whenever the
// compositor thinks it might want the gesture -- inside a scrollable region that
// is nearly every touch, often after a pixel or two of thumb travel and with no
// scroll ever happening. Ignoring those (the obvious reading of "cancel") makes
// tapping a highlight work only sometimes. Ignoring *all* of them is wrong;
// ignoring none of them would turn every scroll and long-press into a tap. So
// the cancelled sequence gets judged on what it actually did.
//
// Pure and DOM-free so it can be unit tested, like geometry.ts.

export interface PointerGesture {
	downX: number;
	downY: number;
	/** Where the pointer was when it ended -- pointerup or pointercancel. */
	endX: number;
	endY: number;
	durationMs: number;
}

/** Maximum finger travel still counted as a tap, in CSS pixels.
 *
 * Deliberately loose. A thumb tap on a phone routinely drifts 6-8px, and iOS
 * cancels the sequence well below the ~10px that feels intuitive; too tight a
 * threshold reinstates the very bug this exists to fix. The asymmetry favours
 * looseness: a false positive shows a popup the next tap dismisses, while a
 * false negative is a tap that silently does nothing. */
export const TAP_MAX_TRAVEL_PX = 16;

/** Above this, the touch was a long-press -- on iOS that promotes to the native
 * text-selection UI, and treating it as a tap would pop the remove menu in the
 * middle of the user selecting text. */
export const TAP_MAX_DURATION_MS = 700;

export function classifyPointerGesture(gesture: PointerGesture): 'tap' | 'gesture' {
	const travel = Math.hypot(gesture.endX - gesture.downX, gesture.endY - gesture.downY);
	if (travel > TAP_MAX_TRAVEL_PX) return 'gesture';
	if (gesture.durationMs > TAP_MAX_DURATION_MS) return 'gesture';
	return 'tap';
}
