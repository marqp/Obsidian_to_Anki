/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
	packageManager: 'pnpm',
	testRunner: 'vitest',
	plugins: ['@stryker-mutator/vitest-runner'],
	reporters: ['progress', 'clear-text', 'html', 'json'],
	mutate: [
		// Mutation scope mirrors the coverage gate: engine modules only.
		// settings.ts stays out (Obsidian-UI, no DOM in tests).
		'src/anki.ts',
		'src/anki-launch.ts',
		'src/commands.ts',
		'src/constants.ts',
		'src/defaults-meta.ts',
		'src/dry-run.ts',
		'src/file.ts',
		'src/files-manager.ts',
		'src/format.ts',
		'src/highlight.ts',
		'src/note.ts',
		'src/notices.ts',
		'src/requests.ts',
		'src/scan-optimizations.ts',
		'src/scan-orchestrator.ts',
		'src/setting-to-data.ts',
		'src/ui/settings-migration.ts'
	],
	coverageAnalysis: 'perTest',
	thresholds: {
		high: 80,
		low: 70,
		break: 60
	},
	concurrency: 4
}
