import { defineConfig } from 'vitest/config'
import path from 'path'

/**
 * Standalone config for the parity suite. The main vitest.config.mjs only
 * includes tests/unit/**; parity runs separately (pnpm run test:parity)
 * because it shells out to node, builds per-side bundles, and needs long
 * per-file timeouts. Not part of the default `pnpm test` gate.
 */
export default defineConfig({
	resolve: {
		alias: {
			obsidian: path.resolve(import.meta.dirname, '../mocks/obsidian.ts')
		}
	},
	test: {
		include: ['tests/parity/parity.test.ts'],
		globals: true,
		testTimeout: 180000,
		hookTimeout: 180000
	}
})
