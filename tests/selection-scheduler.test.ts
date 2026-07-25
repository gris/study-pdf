import { describe, it, expect } from 'vitest';
import { shouldReplacePendingUpdate } from '../src/selection-scheduler';

describe('shouldReplacePendingUpdate', () => {
	it('schedules anything when nothing is pending', () => {
		expect(shouldReplacePendingUpdate(null, 'full')).toBe(true);
		expect(shouldReplacePendingUpdate(null, 'selection-only')).toBe(true);
	});

	it('does not let a late selection-only cancel a pending full', () => {
		// The bug: tapping elsewhere on iOS collapses the selection and delivers
		// selectionchange after pointerup. Losing the 'full' here means the only
		// check that can hide the popup never runs.
		expect(shouldReplacePendingUpdate('full', 'selection-only')).toBe(false);
	});

	it('lets a full replace a pending selection-only', () => {
		expect(shouldReplacePendingUpdate('selection-only', 'full')).toBe(true);
	});

	it('lets a full re-arm a pending full', () => {
		// Two taps in a row must reset the debounce rather than run the check on
		// the first tap's schedule.
		expect(shouldReplacePendingUpdate('full', 'full')).toBe(true);
	});

	it('lets a selection-only re-arm a pending selection-only', () => {
		// Dragging a selection handle fires many of these; each should push the
		// debounce out so the popup rebuilds once, when the drag settles.
		expect(shouldReplacePendingUpdate('selection-only', 'selection-only')).toBe(true);
	});
});
