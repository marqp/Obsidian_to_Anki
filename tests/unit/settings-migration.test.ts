import { describe, it, expect } from 'vitest'
import { migrateSettings } from '../../src/ui/settings-migration'
import { DEFAULT_IGNORED_FILE_GLOBS } from '../../src/settings'
import type { PluginSettings } from '../../src/interfaces/settings-interface'

function modernSettings(overrides: Partial<PluginSettings> = {}): PluginSettings {
	return {
		CUSTOM_REGEXPS: {},
		FILE_LINK_FIELDS: {},
		CONTEXT_FIELDS: {},
		FOLDER_DECKS: {},
		FOLDER_TAGS: {},
		Syntax: {
			'Begin Note': 'START',
			'End Note': 'END',
			'Begin Inline Note': 'STARTI',
			'End Inline Note': 'ENDI',
			'Target Deck Line': 'TARGET DECK',
			'File Tags Line': 'FILE TAGS',
			'Delete Note Line': 'DELETE',
			'Frozen Fields Line': 'FROZEN'
		},
		Defaults: {
			'Scan Directories': [],
			Tag: 'Obsidian_to_Anki',
			Deck: 'Default',
			'Scheduling Interval': 0,
			'Add File Link': false,
			'Add Context': false,
			CurlyCloze: false,
			'CurlyCloze - Highlights to Clozes': false,
			'ID Comments': true,
			'Add Obsidian Tags': false,
			'Anki API Key': '',
			'Sync to AnkiWeb': false,
			'Delete Removed Notes': true,
			'Allow Note Type Changes': false,
			'Auto-launch Anki': false,
			'Confirm Before Sync': false
		},
		IGNORED_FILE_GLOBS: [...DEFAULT_IGNORED_FILE_GLOBS],
		...overrides
	}
}

describe('migrateSettings', () => {
	it('leaves current-schema settings untouched (dirty=false, same reference)', () => {
		const settings = modernSettings()
		const result = migrateSettings(settings)

		expect(result.dirty).toBe(false)
		expect(result.settings).toBe(settings)
	})

	it('migrates a legacy Scan Directory string and drops the old key', () => {
		const settings = modernSettings({
			Defaults: { ...modernSettings().Defaults, 'Scan Directory': 'Notes/Med' } as PluginSettings['Defaults']
		})
		const result = migrateSettings(settings)

		expect(result.dirty).toBe(true)
		expect(result.settings.Defaults['Scan Directories']).toEqual(['Notes/Med'])
		expect('Scan Directory' in result.settings.Defaults).toBe(false)
	})

	it('maps a blank legacy Scan Directory to an empty list', () => {
		const settings = modernSettings({
			Defaults: { ...modernSettings().Defaults, 'Scan Directory': '   ' } as PluginSettings['Defaults']
		})
		const result = migrateSettings(settings)

		expect(result.dirty).toBe(true)
		expect(result.settings.Defaults['Scan Directories']).toEqual([])
	})

	it('fills every missing default with its documented value', () => {
		const settings = modernSettings({ Defaults: { Tag: 'X', Deck: 'Y' } as PluginSettings['Defaults'] })
		const result = migrateSettings(settings)

		expect(result.dirty).toBe(true)
		expect(result.settings.Defaults['Scan Directories']).toEqual([])
		expect(result.settings.Defaults['Add Context']).toBe(false)
		expect(result.settings.Defaults['Scheduling Interval']).toBe(0)
		expect(result.settings.Defaults['CurlyCloze - Highlights to Clozes']).toBe(false)
		expect(result.settings.Defaults['Add Obsidian Tags']).toBe(false)
		expect(result.settings.Defaults['Anki API Key']).toBe('')
		expect(result.settings.Defaults['Sync to AnkiWeb']).toBe(false)
		expect(result.settings.Defaults['Delete Removed Notes']).toBe(true)
		expect(result.settings.Defaults['Allow Note Type Changes']).toBe(false)
		expect(result.settings.Defaults['Auto-launch Anki']).toBe(false)
		// Present values are never overwritten.
		expect(result.settings.Defaults.Tag).toBe('X')
		expect(result.settings.Defaults.Deck).toBe('Y')
	})

	it('ensures record shape and prunes empty folder rules', () => {
		const settings = modernSettings({
			CONTEXT_FIELDS: undefined as unknown as Record<string, string>,
			FOLDER_DECKS: { 'Notes/Empty': '', 'Notes/Spaces': '   ', 'Notes/Bio': 'BioDeck' },
			FOLDER_TAGS: { 'Notes/EmptyTag': '' },
			IGNORED_FILE_GLOBS: undefined as unknown as string[]
		})
		const result = migrateSettings(settings)

		expect(result.dirty).toBe(true)
		expect(result.settings.CONTEXT_FIELDS).toEqual({})
		expect(result.settings.FOLDER_DECKS).toEqual({ 'Notes/Bio': 'BioDeck' })
		expect(result.settings.FOLDER_TAGS).toEqual({})
		expect(result.settings.IGNORED_FILE_GLOBS).toEqual(DEFAULT_IGNORED_FILE_GLOBS)
	})

	it('is idempotent: a second run over migrated settings is clean', () => {
		const settings = modernSettings({
			Defaults: { Tag: 'X' } as PluginSettings['Defaults'],
			FOLDER_DECKS: { 'Notes/Empty': '' }
		})
		const first = migrateSettings(settings)
		expect(first.dirty).toBe(true)
		const second = migrateSettings(first.settings)
		expect(second.dirty).toBe(false)
	})
})
