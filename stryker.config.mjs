/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
	packageManager: 'pnpm',
	testRunner: 'vitest',
	plugins: ['@stryker-mutator/vitest-runner'],
	reporters: ['progress', 'clear-text', 'html', 'json'],
	mutate: [
		'src/scan-optimizations.ts',
		'src/constants.ts',
		'src/note.ts',
		'src/setting-to-data.ts'
	],
	coverageAnalysis: 'perTest',
	thresholds: {
		high: 80,
		low: 70,
		break: 60
	},
	concurrency: 4
}
