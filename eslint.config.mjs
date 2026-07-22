// Lints against the same rule set the Obsidian community-plugin review
// process checks for (see https://github.com/obsidianmd/eslint-plugin) --
// catches deprecated-API usage, DOM-helper preferences, unsafe `any` flow,
// etc. locally instead of one review comment at a time.
import tsparser from '@typescript-eslint/parser';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
	// Scoped to src/: that's the code that actually ships in main.js and gets
	// reviewed. Test helpers legitimately use Node built-ins (node:fs, node:url)
	// that obsidianmd's no-nodejs-modules rule would otherwise flag.
	{
		files: ['src/**/*.ts'],
		extends: [...tseslint.configs.recommendedTypeChecked, ...obsidianmd.configs.recommended],
		languageOptions: {
			parser: tsparser,
			parserOptions: { project: './tsconfig.json' },
		},
	},
	{
		// The one file allowed to touch undocumented Obsidian/PDF.js internals
		// (see its own header comment) -- their shape is inherently untyped, so
		// `any` and the unsafe-* rules it trips are the deliberate point of this
		// file, not an oversight. A config-level override, not inline disables:
		// obsidianmd's config blocks inline-disabling no-explicit-any outright
		// (eslint-comments/no-restricted-disable), precisely to stop it being
		// silenced piecemeal instead of contained to one reviewable file.
		files: ['src/obsidian-pdf-internals.ts'],
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-unsafe-assignment': 'off',
			'@typescript-eslint/no-unsafe-member-access': 'off',
			'@typescript-eslint/no-unsafe-call': 'off',
			'@typescript-eslint/no-unsafe-return': 'off',
		},
	},
]);
