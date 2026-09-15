import { describe, it, expect } from 'vitest'
import { Note, NOTE_TYPE_ERROR } from '../../src/note'
import { FormatConverter } from '../../src/format'
import type { FileData } from '../../src/interfaces/settings-interface'

function createDummyFileData(curlyCloze = true, highlightsToCloze = true): FileData {
	return {
		fields_dict: {
			Basic: ['Front', 'Back'],
			Cloze: ['Text', 'Extra']
		},
		custom_regexps: {},
		file_link_fields: {},
		context_fields: {},
		template: {
			deckName: 'Default',
			modelName: '',
			fields: {},
			options: { allowDuplicate: false, duplicateScope: 'deck' },
			tags: []
		},
		EXISTING_IDS: new Set([1780000000000]),
		vault_name: 'test-vault',
		FROZEN_REGEXP: /FROZEN/g,
		DECK_REGEXP: /TARGET DECK/m,
		TAG_REGEXP: /FILE TAGS/m,
		NOTE_REGEXP: /START[\s\S]*?END/gm,
		INLINE_REGEXP: /STARTI.*?ENDI/g,
		EMPTY_REGEXP: /DELETE/g,
		curly_cloze: curlyCloze,
		highlights_to_cloze: highlightsToCloze,
		comment: true,
		add_context: false,
		add_obs_tags: false
	}
}

describe('Regression: Note and InlineNote parsing', () => {
	it('parses Basic note fields and ID correctly', () => {
		const fileData = createDummyFileData()
		const formatter = new FormatConverter({} as any, fileData.vault_name)
		const noteText = 'Basic\nFront: Capital of Brazil\nBack: Brasília\n<!--ID: 1780000000000-->'

		const note = new Note(noteText, fileData.fields_dict, false, false, formatter)
		const parsed = note.parse('Medicina', '', {}, fileData, '')

		expect(parsed.identifier).toBe(1780000000000)
		expect(parsed.note.modelName).toBe('Basic')
		expect(parsed.note.deckName).toBe('Medicina')
		expect(parsed.note.fields['Front']).toContain('Capital of Brazil')
		expect(parsed.note.fields['Back']).toContain('Brasília')
	})

	it('parses curly clozes and highlights into Anki cloze syntax', () => {
		const fileData = createDummyFileData(true, true)
		const formatter = new FormatConverter({} as any, fileData.vault_name)
		const noteText = 'Cloze\nText: O {c1:coração} bombeia sangue através de ==artérias==.\nExtra: Fisiologia'

		const note = new Note(noteText, fileData.fields_dict, true, true, formatter)
		const parsed = note.parse('Medicina', '', {}, fileData, '')

		expect(parsed.note.modelName).toBe('Cloze')
		// c1 curly cloze should be standard Anki cloze
		expect(parsed.note.fields['Text']).toContain('{{c1::coração}}')
		// highlight should be converted to cloze
		expect(parsed.note.fields['Text']).toContain('{{c')
	})

	it('returns NOTE_TYPE_ERROR for unrecognized model names', () => {
		const fileData = createDummyFileData()
		const formatter = new FormatConverter({} as any, fileData.vault_name)
		const noteText = 'NonExistentType\nField1: Val1\nField2: Val2'

		const note = new Note(noteText, fileData.fields_dict, false, false, formatter)
		const parsed = note.parse('Medicina', '', {}, fileData, '')

		expect(parsed.identifier).toBe(NOTE_TYPE_ERROR)
	})
})
