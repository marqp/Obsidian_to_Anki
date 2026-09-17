import { describe, it, expect, vi } from 'vitest'
import { settingToData } from '../../src/setting-to-data'
import * as AnkiConnect from '../../src/anki'
import type { PluginSettings } from '../../src/interfaces/settings-interface'
import type { App } from 'obsidian'

describe('settingToData configuration parser', () => {
	function createMockSettings(overrides: Partial<PluginSettings> = {}): PluginSettings {
		return {
			CUSTOM_REGEXPS: { CustomModel: '.*' },
			FILE_LINK_FIELDS: { Basic: 'Source' },
			CONTEXT_FIELDS: { Basic: 'Context' },
			FOLDER_DECKS: { 'Folder/A': 'DeckA' },
			FOLDER_TAGS: { 'Folder/A': 'tagA' },
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
				Deck: 'DefaultDeck',
				'Scheduling Interval': 0,
				'Add File Link': true,
				'Add Context': true,
				CurlyCloze: true,
				'CurlyCloze - Highlights to Clozes': true,
				'ID Comments': false,
				'Add Obsidian Tags': true,
				'Anki API Key': '',
				'Sync to AnkiWeb': true,
				'Delete Removed Notes': true,
				'Allow Note Type Changes': true
			},
			IGNORED_FILE_GLOBS: ['**/ignored/**'],
			...overrides
		}
	}

	const mockApp = {
		vault: {
			getName: () => 'TestVault'
		}
	} as unknown as App

	it('correctly maps vault name, fields dict, collections, and template', async () => {
		const invokeSpy = vi.spyOn(AnkiConnect, 'invoke').mockResolvedValueOnce([101, 202, 303])

		const settings = createMockSettings()
		const fieldsDict = { Basic: ['Front', 'Back'] }

		const result = await settingToData(mockApp, settings, fieldsDict)

		expect(invokeSpy).toHaveBeenCalledWith('findNotes', { query: '' })

		expect(result.vault_name).toBe('TestVault')
		expect(result.fields_dict).toBe(fieldsDict)
		expect(result.custom_regexps).toBe(settings.CUSTOM_REGEXPS)
		expect(result.file_link_fields).toBe(settings.FILE_LINK_FIELDS)
		expect(result.context_fields).toBe(settings.CONTEXT_FIELDS)
		expect(result.folder_decks).toBe(settings.FOLDER_DECKS)
		expect(result.folder_tags).toBe(settings.FOLDER_TAGS)

		expect(result.template.deckName).toBe('DefaultDeck')
		expect(result.template.modelName).toBe('')
		expect(result.template.fields).toEqual({})
		expect(result.template.options.allowDuplicate).toBe(true)
		expect(result.template.tags).toEqual(['Obsidian_to_Anki'])

		expect(result.EXISTING_IDS).toEqual(new Set([101, 202, 303]))
	})

	it('maps all boolean defaults and handles fallback for IGNORED_FILE_GLOBS', async () => {
		vi.spyOn(AnkiConnect, 'invoke').mockResolvedValueOnce([])

		const settings = createMockSettings({
			IGNORED_FILE_GLOBS: undefined
		})
		const result = await settingToData(mockApp, settings, {})

		expect(result.curly_cloze).toBe(true)
		expect(result.highlights_to_cloze).toBe(true)
		expect(result.add_file_link).toBe(true)
		expect(result.comment).toBe(false)
		expect(result.add_context).toBe(true)
		expect(result.add_obs_tags).toBe(true)
		expect(result.sync_to_ankiweb).toBe(true)
		expect(result.delete_removed_notes).toBe(true)
		expect(result.allow_note_type_changes).toBe(true)
		expect(result.ignored_file_globs).toEqual([])
	})

	it('defaults sync_to_ankiweb and allow_note_type_changes to false when missing', async () => {
		vi.spyOn(AnkiConnect, 'invoke').mockResolvedValueOnce([])

		const settings = createMockSettings()
		delete settings.Defaults['Sync to AnkiWeb']
		delete settings.Defaults['Allow Note Type Changes']
		const result = await settingToData(mockApp, settings, {})

		expect(result.sync_to_ankiweb).toBe(false)
		expect(result.allow_note_type_changes).toBe(false)
	})

	it('defaults delete_removed_notes to true when the setting is missing', async () => {
		vi.spyOn(AnkiConnect, 'invoke').mockResolvedValueOnce([])

		const settings = createMockSettings()
		delete settings.Defaults['Delete Removed Notes']
		const result = await settingToData(mockApp, settings, {})

		expect(result.delete_removed_notes).toBe(true)
	})

	it('constructs working RegExps from syntax configuration', async () => {
		vi.spyOn(AnkiConnect, 'invoke').mockResolvedValueOnce([])

		const settings = createMockSettings()
		const result = await settingToData(mockApp, settings, {})

		// FROZEN_REGEXP: 'FROZEN - Field:\ncontent'
		expect('FROZEN - Front:\nFrozenContent'.match(result.FROZEN_REGEXP)).toBeTruthy()

		// DECK_REGEXP: '^TARGET DECK(?:\n|: )(.*)'
		const deckMatch = 'TARGET DECK: MySpecialDeck'.match(result.DECK_REGEXP)
		expect(deckMatch?.[1]).toBe('MySpecialDeck')

		// TAG_REGEXP: '^FILE TAGS(?:\n|: )(.*)'
		const tagMatch = 'FILE TAGS: tag1 tag2'.match(result.TAG_REGEXP)
		expect(tagMatch?.[1]).toBe('tag1 tag2')

		// NOTE_REGEXP: '^START[ ]*\n([\s\S]*?\n)END[ ]*'
		const noteText = 'START\nBasic\nFront: Q\nBack: A\nEND'
		const noteMatches = [...noteText.matchAll(result.NOTE_REGEXP)]
		expect(noteMatches.length).toBe(1)
		expect(noteMatches[0][1]).toBe('Basic\nFront: Q\nBack: A\n')

		// INLINE_REGEXP: 'STARTI(.*?)ENDI'
		const inlineText = 'Some text STARTI [Basic] Q Back: A ENDI more text'
		const inlineMatches = [...inlineText.matchAll(result.INLINE_REGEXP)]
		expect(inlineMatches.length).toBe(1)
		expect(inlineMatches[0][1]).toBe(' [Basic] Q Back: A ')

		// EMPTY_REGEXP: 'DELETE' + ID_REGEXP_STR
		const deleteText = 'DELETE\n<!--ID: 1234567890123-->'
		expect(deleteText.match(result.EMPTY_REGEXP)).toBeTruthy()
	})

	it('anchors TARGET DECK and FILE TAGS to line starts', async () => {
		vi.spyOn(AnkiConnect, 'invoke').mockResolvedValueOnce([])

		const result = await settingToData(mockApp, createMockSettings(), {})

		expect('prefix TARGET DECK: X'.match(result.DECK_REGEXP)).toBeNull()
		expect('prefix FILE TAGS: a'.match(result.TAG_REGEXP)).toBeNull()
		// The NOTE pattern is multiline-anchored; a mid-line START is ignored.
		expect('prefix START\nBasic\nFront: Q\nBack: A\nEND'.match(result.NOTE_REGEXP)).toBeNull()
	})

	it('pins the multiline flags on the anchored patterns', async () => {
		vi.spyOn(AnkiConnect, 'invoke').mockResolvedValueOnce([])

		const result = await settingToData(mockApp, createMockSettings(), {})

		expect(result.NOTE_REGEXP.multiline).toBe(true)
		expect(result.DECK_REGEXP.multiline).toBe(true)
		expect(result.TAG_REGEXP.multiline).toBe(true)
		// FROZEN/DELETE have no ^ anchor by construction; their multiline
		// use is via explicit \n in the pattern, not the flag.
		expect(result.FROZEN_REGEXP.multiline).toBe(false)
		expect(result.EMPTY_REGEXP.multiline).toBe(false)
	})

	it('breaks NOTE matching when the Begin token is empty', async () => {
		vi.spyOn(AnkiConnect, 'invoke').mockResolvedValueOnce([])

		const settings = createMockSettings()
		settings.Syntax['Begin Note'] = ''
		const result = await settingToData(mockApp, settings, {})

		// An empty Begin token anchors on a bare newline + capture, so a
		// well-formed block no longer matches as a note.
		expect('START\nBasic\nFront: Q\nBack: A\nEND'.match(result.NOTE_REGEXP)).toBeNull()
	})
})

describe('settingToData regexp part pinning', () => {
	const pinApp = {
		vault: {
			getName: () => 'TestVault'
		}
	} as unknown as App

	function pinSettings(): PluginSettings {
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
				Deck: 'D',
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
				'Auto-launch Anki': false
			},
			IGNORED_FILE_GLOBS: []
		}
	}

	it('pins the FROZEN separator and flags literally', async () => {
		vi.spyOn(AnkiConnect, 'invoke').mockResolvedValueOnce([])
		const result = await settingToData(pinApp, pinSettings(), {})

		expect(result.FROZEN_REGEXP.source).toContain(' - (.*?):')
		expect(result.FROZEN_REGEXP.flags).toBe('g')
	})

	it('pins the global flag and trailing-space tolerance literally', async () => {
		vi.spyOn(AnkiConnect, 'invoke').mockResolvedValueOnce([])
		const result = await settingToData(pinApp, pinSettings(), {})

		expect(result.NOTE_REGEXP.flags).toBe('gm')
		expect(result.EMPTY_REGEXP.flags).toBe('g')
		expect('START   \nBasic\nFront: Q\nBack: A\nEND   ').toMatchObject(result.NOTE_REGEXP)
	})
})
