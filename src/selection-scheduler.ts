// Priority rule for the two kinds of selection check that share one debounce.
//
// 'full' runs after a click/tap: it shows the colour dots for a real selection,
// and otherwise *hides* any open popup before looking for a highlight to remove.
// 'selection-only' runs while a selection is being adjusted: it refreshes the
// popup for a live selection and does nothing when there isn't one -- it can't
// hide anything, because a selection merely collapsing isn't the deliberate user
// action that dismissing a popup requires.
//
// They share a timer, so the naive "last caller wins" lets a 'selection-only'
// arriving late overwrite a pending 'full'. Then the only check that can dismiss
// the popup never runs, and it sits there until something else clears it. On
// desktop the order is mousedown -> selectionchange -> mouseup, so 'full' always
// lands last and this never bites; on iOS the pointer and selection events are
// not ordered that way, and tapping elsewhere leaves the popup stranded.
//
// Pure and DOM-free so it can be unit tested, like geometry.ts.

export type SelectionUpdateMode = 'full' | 'selection-only';

/** Whether an incoming check should replace one already scheduled.
 *
 * Only ever false for the downgrade case: a pending 'full' outranks an incoming
 * 'selection-only', because 'full' is a superset -- it handles a live selection
 * identically and additionally handles its absence. Re-arming 'full' with a
 * fresh 'full' stays allowed, so a later tap still resets the debounce. */
export function shouldReplacePendingUpdate(
	pending: SelectionUpdateMode | null,
	incoming: SelectionUpdateMode,
): boolean {
	if (pending === null) return true;
	return !(pending === 'full' && incoming === 'selection-only');
}
