import { describe, it, expect } from 'vitest';
import {
	classifyPointerGesture,
	TAP_MAX_TRAVEL_PX,
	TAP_MAX_DURATION_MS,
	type PointerGesture,
} from '../src/tap-gesture';

const gesture = (over: Partial<PointerGesture> = {}): PointerGesture => ({
	downX: 100,
	downY: 200,
	endX: 100,
	endY: 200,
	durationMs: 90,
	...over,
});

describe('classifyPointerGesture', () => {
	it('treats a still, brief touch as a tap', () => {
		expect(classifyPointerGesture(gesture())).toBe('tap');
	});

	it('treats a thumb tap that drifts a few pixels as a tap', () => {
		// The whole point: iOS cancels these, and they are what the user means.
		expect(classifyPointerGesture(gesture({ endX: 107, endY: 205 }))).toBe('tap');
	});

	it('treats a drag as a gesture', () => {
		expect(classifyPointerGesture(gesture({ endY: 400 }))).toBe('gesture');
	});

	it('treats a long press as a gesture even if it never moved', () => {
		// On iOS this promotes to the native text-selection UI; showing the
		// remove popup mid-selection would fight the OS.
		expect(classifyPointerGesture(gesture({ durationMs: 1200 }))).toBe('gesture');
	});

	it('measures travel diagonally, not per axis', () => {
		// 12px on each axis is under the threshold alone but ~17px combined.
		expect(classifyPointerGesture(gesture({ endX: 112, endY: 212 }))).toBe('gesture');
	});

	it('accepts travel exactly at the limit and rejects just past it', () => {
		expect(classifyPointerGesture(gesture({ endX: 100 + TAP_MAX_TRAVEL_PX }))).toBe('tap');
		expect(classifyPointerGesture(gesture({ endX: 100 + TAP_MAX_TRAVEL_PX + 0.1 }))).toBe('gesture');
	});

	it('accepts duration exactly at the limit and rejects just past it', () => {
		expect(classifyPointerGesture(gesture({ durationMs: TAP_MAX_DURATION_MS }))).toBe('tap');
		expect(classifyPointerGesture(gesture({ durationMs: TAP_MAX_DURATION_MS + 1 }))).toBe('gesture');
	});

	it('rejects a slow drag on both counts', () => {
		expect(classifyPointerGesture(gesture({ endY: 500, durationMs: 3000 }))).toBe('gesture');
	});
});
