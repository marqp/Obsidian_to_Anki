import { defineConfig } from 'vitest/config'
import path from 'path'

/**
 * Standalone config for the bench suite. Separate from parity (correctness)
 * and unit (coverage gate): fileParallelism off isolates GC between sides,
 * long timeouts cover the full rep matrix, and --expose-gc enables explicit
 * collection between reps. Not part of `pnpm test`.
 */
export default defineConfig({
	resolve: {
		alias: {
			obsidian: path.resolve(import.meta.dirname, '../mocks/obsidian.ts')
		}
	},
	test: {
		include: ['tests/parity/bench.test.ts'],
		globals: true,
		testTimeout: 600000,
		hookTimeout: 180000,
		pool: 'forks',
		fileParallelism: false,
		execArgv: ['--expose-gc']
	}
})
