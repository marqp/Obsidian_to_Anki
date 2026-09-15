import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
	resolve: {
		alias: {
			obsidian: path.resolve(import.meta.dirname, 'tests/mocks/obsidian.ts')
		}
	},
	test: {
		include: ['tests/unit/**/*.test.ts'],
		globals: true,
		coverage: {
			provider: 'v8',
			reporter: ['text', 'lcov'],
			include: [
				'src/scan-optimizations.ts',
				'src/constants.ts',
				'src/note.ts',
				'src/setting-to-data.ts',
				'src/format.ts',
				'src/file.ts'
			],
			thresholds: {
				lines: 70,
				functions: 70
			}
		}
	}
})
