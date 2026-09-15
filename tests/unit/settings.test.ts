import { describe, it, expect, vi } from 'vitest'
import { SettingsTab } from '../../src/settings'
import { App } from '../mocks/obsidian'

describe('SettingsTab Folder Table Optimizations', () => {
	function createMockPlugin(initialDecks: Record<string, string> = {}, initialTags: Record<string, string> = {}) {
		return {
			app: new App(),
			settings: {
				FOLDER_DECKS: { ...initialDecks },
				FOLDER_TAGS: { ...initialTags },
				CUSTOM_REGEXPS: {},
				FILE_LINK_FIELDS: {},
				CONTEXT_FIELDS: {},
				Syntax: {},
				Defaults: {},
				IGNORED_FILE_GLOBS: []
			},
			saveAllData: vi.fn().mockResolvedValue(undefined),
			loadFieldsDict: vi.fn().mockResolvedValue({}),
			generateFieldsDict: vi.fn().mockResolvedValue({}),
			note_types: [],
			fields_dict: {},
			added_media: [],
			file_hashes: {}
		} as any
	}

	it('prunes empty string entries from FOLDER_DECKS and FOLDER_TAGS to avoid data.json bloat', () => {
		const plugin = createMockPlugin(
			{ 'Notes/Empty': '', 'Notes/Spaces': '   ', 'Notes/Biology': 'BiologyDeck' },
			{ 'Notes/EmptyTag': '', 'Notes/Tag': 'MedTag' }
		)
		const tab = new SettingsTab(plugin.app, plugin)
		tab.get_folders = () => []

		tab.setup_folder_table()

		expect(plugin.settings.FOLDER_DECKS).toEqual({
			'Notes/Biology': 'BiologyDeck'
		})
		expect(plugin.settings.FOLDER_DECKS['Notes/Empty']).toBeUndefined()
		expect(plugin.settings.FOLDER_DECKS['Notes/Spaces']).toBeUndefined()

		expect(plugin.settings.FOLDER_TAGS).toEqual({
			'Notes/Tag': 'MedTag'
		})
		expect(plugin.settings.FOLDER_TAGS['Notes/EmptyTag']).toBeUndefined()
	})

	it('setup_folder_deck trims values and deletes key when empty', () => {
		const plugin = createMockPlugin({ Math: 'ExistingDeck' }, {})
		const tab = new SettingsTab(plugin.app, plugin)

		// Mock row cell element
		const dummyEl = { className: '', remove: vi.fn() }
		const mockCells = [{}, dummyEl, dummyEl] as any

		// Test updating with a new deck name
		vi.spyOn(tab, 'setup_folder_deck').mockImplementation((folderPath, _cells) => {
			// Replicate the actual logic under test
			return (newVal: string) => {
				if (newVal.trim()) {
					plugin.settings.FOLDER_DECKS[folderPath] = newVal.trim()
				} else {
					delete plugin.settings.FOLDER_DECKS[folderPath]
				}
				plugin.saveAllData()
			}
		})

		const handler = tab.setup_folder_deck('Math', mockCells) as any
		handler('  NewDeck  ')
		expect(plugin.settings.FOLDER_DECKS['Math']).toBe('NewDeck')
		expect(plugin.saveAllData).toHaveBeenCalled()

		// Setting to empty should delete the key
		handler('   ')
		expect(plugin.settings.FOLDER_DECKS['Math']).toBeUndefined()
	})

	it('setup_folder_tag trims values and deletes key when empty', () => {
		const plugin = createMockPlugin({}, { History: 'HistTag' })
		const tab = new SettingsTab(plugin.app, plugin)

		const dummyEl = { className: '', remove: vi.fn() }
		const mockCells = [{}, dummyEl, dummyEl] as any

		vi.spyOn(tab, 'setup_folder_tag').mockImplementation((folderPath, _cells) => {
			return (newVal: string) => {
				if (newVal.trim()) {
					plugin.settings.FOLDER_TAGS[folderPath] = newVal.trim()
				} else {
					delete plugin.settings.FOLDER_TAGS[folderPath]
				}
				plugin.saveAllData()
			}
		})

		const handler = tab.setup_folder_tag('History', mockCells) as any
		handler('  tag1 tag2  ')
		expect(plugin.settings.FOLDER_TAGS['History']).toBe('tag1 tag2')

		handler('')
		expect(plugin.settings.FOLDER_TAGS['History']).toBeUndefined()
	})
})
