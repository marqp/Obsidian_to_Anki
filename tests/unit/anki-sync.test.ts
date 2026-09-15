import { describe, it, expect, vi } from 'vitest'
import * as AnkiConnect from '../../src/anki'
import { FileManager } from '../../src/files-manager'
import type { ParsedSettings } from '../../src/interfaces/settings-interface'
import type { App } from 'obsidian'

function createParsedSettings(syncToAnkiweb: boolean): ParsedSettings {
	return {
		fields_dict: { Basic: ['Front', 'Back'] },
		custom_regexps: {},
		file_link_fields: {},
		context_fields: {},
		template: {
			deckName: 'Default',
			modelName: '',
			fields: {},
			options: { allowDuplicate: true },
			tags: ['Obsidian_to_Anki']
		},
		EXISTING_IDS: new Set<number>(),
		vault_name: 'test-vault',
		FROZEN_REGEXP: /FROZEN/g,
		DECK_REGEXP: /TARGET DECK/m,
		TAG_REGEXP: /FILE TAGS/m,
		NOTE_REGEXP: /START[\s\S]*?END/gm,
		INLINE_REGEXP: /STARTI.*?ENDI/g,
		EMPTY_REGEXP: /DELETE/g,
		curly_cloze: false,
		highlights_to_cloze: false,
		comment: true,
		add_context: false,
		add_obs_tags: false,
		add_file_link: false,
		folder_decks: {},
		folder_tags: {},
		ignored_file_globs: [],
		sync_to_ankiweb: syncToAnkiweb,
		allow_note_type_changes: false
	}
}

describe('AnkiWeb sync hook', () => {
	it('never calls sync when the toggle is off', async () => {
		const invokeSpy = vi.spyOn(AnkiConnect, 'invoke').mockResolvedValue([])
		const manager = new FileManager({} as App, createParsedSettings(false), [], {}, [])

		await manager.requests_2()

		const actions = invokeSpy.mock.calls.map((call) => call[0])
		expect(actions).not.toContain('sync')
		vi.restoreAllMocks()
	})

	it('calls sync once at the end when the toggle is on', async () => {
		const invokeSpy = vi.spyOn(AnkiConnect, 'invoke').mockResolvedValue([])
		const manager = new FileManager({} as App, createParsedSettings(true), [], {}, [])

		await manager.requests_2()

		const actions = invokeSpy.mock.calls.map((call) => call[0])
		expect(actions.filter((action) => action === 'sync')).toHaveLength(1)
		expect(actions[actions.length - 1]).toBe('sync')
		vi.restoreAllMocks()
	})

	it('resolves normally when sync fails (local scan already succeeded)', async () => {
		vi.spyOn(AnkiConnect, 'invoke').mockImplementation(async (action: string) => {
			if (action === 'sync') {
				throw new AnkiConnect.AnkiConnectError('sync', 'not logged in')
			}
			return []
		})
		const manager = new FileManager({} as App, createParsedSettings(true), [], {}, [])

		await expect(manager.requests_2()).resolves.toBeUndefined()
		vi.restoreAllMocks()
	})
})
