// Plugin settings: the highlight color palette and the settings tab UI.
// Deliberately independent of main.ts / the Obsidian-internals adapter --
// this only touches the well-documented Plugin/PluginSettingTab/Setting APIs.
import { App, PluginSettingTab, Setting, type ExtraButtonComponent, type SettingDefinitionItem } from 'obsidian';
import type { RgbColor } from './annotate';

export interface HighlightColorOption {
	name: string;
	/** e.g. "#ffeb3b" */
	hex: string;
}

export interface PdfHighlighterSettings {
	colors: HighlightColorOption[];
	defaultColorName: string;
}

// The exact color set of the reference highlighter the user compares us to --
// not estimated from screenshots, but read out of that software's own /C color
// entries in the user's real textbook annotations. Opacity is deliberately NOT
// configurable: highlights render at full opacity with the Multiply blend, so
// over white paper they show exactly these hexes while text stays fully
// readable -- identical to how that software renders.
export const DEFAULT_SETTINGS: PdfHighlighterSettings = {
	colors: [
		{ name: 'Yellow', hex: '#ffff00' },
		{ name: 'Red', hex: '#ff0000' },
		{ name: 'Orange', hex: '#ff8000' },
		{ name: 'Green', hex: '#00ff00' },
		{ name: 'Purple', hex: '#a22cff' },
	],
	defaultColorName: 'Yellow',
};

export function hexToRgbColor(hex: string): RgbColor {
	const normalized = hex.replace('#', '');
	const r = parseInt(normalized.slice(0, 2), 16) / 255;
	const g = parseInt(normalized.slice(2, 4), 16) / 255;
	const b = parseInt(normalized.slice(4, 6), 16) / 255;
	return { r, g, b };
}

export function getDefaultColor(settings: PdfHighlighterSettings): HighlightColorOption {
	return (
		settings.colors.find((c) => c.name === settings.defaultColorName) ??
		settings.colors[0] ?? DEFAULT_SETTINGS.colors[0]!
	);
}

/** What the settings tab needs from the plugin -- kept minimal and decoupled from
 * main.ts's concrete class to avoid a circular import. */
export interface SettingsHost {
	settings: PdfHighlighterSettings;
	saveSettings(): Promise<void>;
}

export class PdfHighlighterSettingTab extends PluginSettingTab {
	private readonly host: SettingsHost;

	constructor(app: App, plugin: import('obsidian').Plugin, host: SettingsHost) {
		super(app, plugin);
		this.host = host;
	}

	/** Star buttons by color name, so picking a new default can repaint every
	 * row's star in place. The declarative path renders rows independently,
	 * so there is no whole-tab re-render to fall back on. */
	private readonly starButtons = new Map<string, ExtraButtonComponent>();

	/** Adds the color swatch + "set as default" star to a Setting row. */
	private buildColorRow(setting: Setting, color: HighlightColorOption) {
		// Show the (fixed) color as a plain swatch, not an editable picker.
		const swatch = setting.controlEl.createSpan({ cls: 'study-pdf-color-dot' });
		swatch.setCssStyles({ backgroundColor: color.hex });
		setting.addExtraButton((button) => {
			this.starButtons.set(color.name, button);
			button.setIcon('star').onClick(async () => {
				this.host.settings.defaultColorName = color.name;
				await this.host.saveSettings();
				this.syncStars();
			});
			this.syncStar(color.name, button);
		});
	}

	private syncStar(name: string, button: ExtraButtonComponent) {
		const isDefault = name === this.host.settings.defaultColorName;
		button.setTooltip(isDefault ? 'Default color' : 'Set as default color');
		// A hover-only background isn't a persistent indicator -- fill the
		// star so the default color is visible at a glance, not just on hover.
		button.extraSettingsEl.toggleClass('study-pdf-default-star', isDefault);
	}

	/** Repaints every live star, dropping rows whose element is gone -- the map
	 * is keyed by color name, so it can outlive the row it describes. */
	private syncStars() {
		for (const [name, button] of this.starButtons) {
			if (button.extraSettingsEl.isConnected) this.syncStar(name, button);
			else this.starButtons.delete(name);
		}
	}

	/** The declarative settings API (Obsidian 1.13.0+). Rows built this way
	 * are indexed by the settings search; display() below is not called at
	 * all when this returns a non-empty array. */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: 'group',
				heading: 'Highlight colors',
				items: this.host.settings.colors.map((color) => ({
					name: color.name,
					aliases: ['default highlight color', color.hex],
					render: (setting: Setting) => {
						this.buildColorRow(setting, color);
						const own = this.starButtons.get(color.name);
						return () => {
							if (this.starButtons.get(color.name) === own) this.starButtons.delete(color.name);
						};
					},
				})),
			},
		];
	}

	/** Fallback for Obsidian older than 1.13.0, which has no
	 * getSettingDefinitions() and renders the tab from here instead. */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.starButtons.clear();

		new Setting(containerEl).setName('Highlight colors').setHeading();

		for (const color of this.host.settings.colors) {
			const setting = new Setting(containerEl).setName(color.name);
			this.buildColorRow(setting, color);
		}
	}
}
