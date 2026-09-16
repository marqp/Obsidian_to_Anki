import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DEFAULTS_META, buildDefaults } from '../../src/defaults-meta'
import { migrateSettings } from '../../src/ui/settings-migration'
import type { PluginSettings } from '../../src/interfaces/settings-interface'

/**
 * `docs/config.md` documents every Defaults key for users. This test pins
 * the doc table to DEFAULTS_META so the UI, data.json and docs cannot drift
 * silently (no generator: the table stays hand-written, the test just fails
 * loudly when a key is added/removed on one side only).
 */
function documentedDefaultKeys(): string[] {
	const doc = fs.readFileSync(path.resolve(__dirname, '../../docs/config.md'), 'utf8')
	const defaultsSection = doc.split('## Defaults')[1]?.split('## Syntax')[0] ?? ''
	const keys: string[] = []
	for (const line of defaultsSection.split('\n')) {
		const match = line.match(/^\| `([^`]+)` \|/)
		if (match) {
			keys.push(match[1])
		}
	}
	return keys.sort()
}

describe('DEFAULTS_META single source', () => {
	it('matches the documented keys in docs/config.md', () => {
		const metaKeys = DEFAULTS_META.map((m) => m.key).sort()
		expect(metaKeys).toEqual(documentedDefaultKeys())
	})

	it('builds a fresh defaults object per call (arrays not shared)', () => {
		const first = buildDefaults()
		const second = buildDefaults()
		expect(first).toEqual(second)
		expect(first['Scan Directories']).not.toBe(second['Scan Directories'])
	})

	it('keeps the documented values for the safety-critical defaults', () => {
		const defaults = buildDefaults()
		expect(defaults['Delete Removed Notes']).toBe(true)
		expect(defaults['Auto-launch Anki']).toBe(false)
		expect(defaults['Allow Note Type Changes']).toBe(false)
		expect(defaults['ID Comments']).toBe(true)
		expect(defaults['Scan Directories']).toEqual([])
	})

	it('migration can fill every default from the meta list', () => {
		const settings = { Defaults: {} } as unknown as PluginSettings
		const { settings: migrated, dirty } = migrateSettings(settings)

		expect(dirty).toBe(true)
		for (const meta of DEFAULTS_META) {
			expect(migrated.Defaults[meta.key]).toEqual(meta.value)
		}
	})
})
