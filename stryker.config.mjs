/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
	packageManager: 'pnpm',
	testRunner: 'vitest',
	plugins: ['@stryker-mutator/vitest-runner'],
	reporters: ['progress', 'clear-text', 'html', 'json'],
	mutate: [
	// Mutation scope mirrors the coverage gate: engine modules only.
	// settings.ts and ui/dry-run-modal.ts stay out (Obsidian-UI, no DOM in
	// tests; the modal's view-model dry-run-view.ts is fully covered).
	'src/anki.ts',
	'src/anki-launch.ts',
	'src/commands.ts',
	'src/constants.ts',
	'src/defaults-meta.ts',
	'src/dry-run.ts',
	'src/dry-run-view.ts',
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
		'src/ui/settings-migration.ts',
		'src/anki-import.ts',
		'src/anki-read.ts',
		'src/html-to-markdown.ts',
		'src/media-records.ts',
		'src/media-sync.ts',
		'src/occlusion.ts',
		'src/occlusion-pull.ts',
		'src/validate.ts',
		'src/api-server.ts',
		'src/progress-notice.ts'
	],
	coverageAnalysis: 'perTest',
	// Reuses the last run's results for code and tests that did not change. It cannot
	// see changes outside the mutated files, such as helpers or dependencies, so the
	// nightly run passes --force to test everything and refresh the results.
	incremental: true,
	thresholds: {
		high: 80,
		low: 70,
		break: 60
	},
	concurrency: 4
}
