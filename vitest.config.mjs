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
				// Engine gate: every src module except settings.ts, which is
				// Obsidian-UI code untestable without a DOM (mock covers
				// construction only). Keep the 70% floor when adding modules.
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
				'src/ui/settings-migration.ts'
			],
			thresholds: {
				lines: 70,
				functions: 70
			}
		}
	}
})
