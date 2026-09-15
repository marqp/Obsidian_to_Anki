import { vi } from 'vitest'
import * as AnkiConnect from '../../src/anki'
import { FileManager } from '../../src/files-manager'
import { AllFile } from '../../src/file'
import { createFileData } from '../../src/scan-optimizations'
import type { ParsedSettings } from '../../src/interfaces/settings-interface'
import type { App, CachedMetadata } from 'obsidian'

export function createParsedSettings(overrides: Partial<ParsedSettings> = {}): ParsedSettings {
	return {
		fields_dict: { Basic: ['Front', 'Back'], Cloze: ['Text'] },
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
		sync_to_ankiweb: false,
		allow_note_type_changes: false,
		...overrides
	}
}

export function createTestFile(data: ParsedSettings): AllFile {
	const file = new AllFile('', 'note.md', '', createFileData(data, 'Default', ['fileTag']), {} as CachedMetadata)
	file.global_tags = 'fileTag'
	file.notes_to_edit = [
		{
			identifier: 55,
			note: {
				deckName: 'Default',
				modelName: 'Cloze',
				fields: { Text: 'cloze content' },
				options: { allowDuplicate: true },
				tags: ['noteTag']
			}
		}
	]
	return file
}

export interface ManagerOptions {
	supportedActions: string[]
	allowNoteTypeChanges?: boolean
	localModelName?: string
	ankiModelName?: string
}

export function createManager(options: ManagerOptions) {
	const parsed = createParsedSettings({ allow_note_type_changes: options.allowNoteTypeChanges ?? false })
	const app = {
		vault: { getName: () => 'vault', modify: vi.fn(), adapter: { getFullPath: (p: string) => p } },
		metadataCache: { getFirstLinkpathDest: () => null }
	} as unknown as App
	const manager = new FileManager(app, parsed, [], {}, [])
	const file = createTestFile(parsed)
	file.notes_to_edit[0].note.modelName = options.localModelName ?? 'Cloze'
	manager.ownFiles = [file]

	const noteInfo = {
		noteId: 55,
		modelName: options.ankiModelName ?? 'Cloze',
		tags: ['noteTag'],
		fields: {},
		cards: [777]
	}
	const multiResponse = [
		{ error: null, result: [] },
		{ error: null, result: [{ error: null, result: [] }] },
		{ error: null, result: [{ error: null, result: [noteInfo] }] },
		{ error: null, result: ['noteTag'] },
		{ error: null, result: [{ error: null, result: [] }] },
		{ error: null, result: [null] },
		{ error: null, result: [] }
	]
	const invokeMock = vi.fn(async (action: string) => {
		if (action === 'apiReflect') {
			return { scopes: ['actions'], actions: options.supportedActions }
		}
		return multiResponse
	})
	// setTransport is the seam that also intercepts anki.ts-internal calls
	// (detectSupportedActions calls invoke() locally, not via the namespace).
	AnkiConnect.setTransport({ invoke: invokeMock })
	return { manager, invokeMock }
}

export function mainMultiActions(invokeMock: ReturnType<typeof vi.fn>): AnkiConnect.AnkiConnectRequest[] {
	const mainMulti = invokeMock.mock.calls[1] as [string, { actions: AnkiConnect.AnkiConnectRequest[] }]
	return mainMulti[1].actions
}

export function requests2Payload(invokeMock: ReturnType<typeof vi.fn>): string {
	const requests2Multi = invokeMock.mock.calls[2] as [string, unknown]
	return JSON.stringify(requests2Multi[1])
}
