// Compact horizontal icon popup (color dots / trash), replacing Obsidian's
// vertical text Menu for the in-PDF actions. Styled exclusively with Obsidian
// CSS variables + the `clickable-icon` class (see styles.css), so it inherits
// the active theme's colors -- the failure mode of the first custom popup
// (hardcoded colors, unreadable in dark themes) can't recur.
import { setIcon, setTooltip } from 'obsidian';

export type PopupButton =
	| { type: 'color'; hex: string; name: string; onClick: () => void }
	| { type: 'icon'; icon: string; label: string; onClick: () => void };

export interface IconPopup {
	el: HTMLElement;
	hide(): void;
}

/** Clamp into the viewport after layout so the popup never overflows an edge.
 * `el` must already be attached to the DOM: Obsidian's createDiv/createEl
 * attach as part of creation (unlike document.createElement, which returns a
 * detached node), so by the time an element exists here, it's already in the
 * tree -- this only positions it. */
function positionPopup(doc: Document, el: HTMLElement, position: { x: number; y: number }) {
	el.setCssStyles({ left: '0px', top: '0px' });
	const { width, height } = el.getBoundingClientRect();
	const win = doc.defaultView ?? window;
	el.setCssStyles({
		left: `${Math.max(4, Math.min(position.x, win.innerWidth - width - 4))}px`,
		top: `${Math.max(4, Math.min(position.y, win.innerHeight - height - 4))}px`,
	});
}

export function showIconPopup(
	doc: Document,
	position: { x: number; y: number },
	buttons: PopupButton[],
	options: { text?: string } = {},
): IconPopup {
	const el = doc.body.createDiv({ cls: 'study-pdf-popup' });

	// Buttons act on the current text selection; without this, mousedown on the
	// popup itself would collapse that selection before the click ever lands.
	el.addEventListener('mousedown', (evt) => evt.preventDefault());

	if (options.text) {
		el.createDiv({ cls: 'study-pdf-popup-note', text: options.text });
	}

	const row = el.createDiv({ cls: 'study-pdf-popup-row' });
	for (const button of buttons) {
		const btnEl = row.createEl('button', { cls: 'clickable-icon' });
		if (button.type === 'color') {
			const dot = btnEl.createSpan({ cls: 'study-pdf-color-dot' });
			dot.setCssStyles({ backgroundColor: button.hex });
			setTooltip(btnEl, button.name);
		} else {
			setIcon(btnEl, button.icon);
			setTooltip(btnEl, button.label);
		}
		btnEl.addEventListener('click', button.onClick);
	}

	positionPopup(doc, el, position);

	return {
		el,
		hide() {
			el.remove();
		},
	};
}

/** Small note editor popup: a textarea prefilled with the current note, plus
 * save/cancel icons. Enter saves (Shift+Enter for a newline), Escape cancels.
 * No mousedown preventDefault here -- the textarea needs real focus/clicks. */
export function showNoteEditorPopup(
	doc: Document,
	position: { x: number; y: number },
	options: { initial: string; onSave: (note: string) => void; onCancel: () => void },
): IconPopup {
	const el = doc.body.createDiv({ cls: 'study-pdf-popup' });

	const input = el.createEl('textarea', {
		cls: 'study-pdf-note-input',
		value: options.initial,
		placeholder: 'Note…',
	});

	const row = el.createDiv({ cls: 'study-pdf-popup-row' });
	const makeButton = (icon: string, label: string, onClick: () => void) => {
		const btnEl = row.createEl('button', { cls: 'clickable-icon' });
		setIcon(btnEl, icon);
		setTooltip(btnEl, label);
		btnEl.addEventListener('click', onClick);
	};
	makeButton('check', 'Save note', () => options.onSave(input.value));
	makeButton('x', 'Cancel', options.onCancel);

	input.addEventListener('keydown', (evt) => {
		if (evt.key === 'Enter' && !evt.shiftKey) {
			evt.preventDefault();
			options.onSave(input.value);
		} else if (evt.key === 'Escape') {
			evt.preventDefault();
			options.onCancel();
		}
	});

	positionPopup(doc, el, position);
	input.focus();

	return {
		el,
		hide() {
			el.remove();
		},
	};
}
