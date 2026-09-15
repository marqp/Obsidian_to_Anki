import { describe, it, expect } from 'vitest'
import { Note } from '../../src/note'
import { FormatConverter } from '../../src/format'
import type { FileData } from '../../src/interfaces/settings-interface'

function createDummyFileData(): FileData {
	return {
		fields_dict: {
			Basic: ['Front', 'Back']
		},
		custom_regexps: { Basic: '' },
		file_link_fields: { Basic: 'Front' },
		context_fields: { Basic: 'Back' },
		template: {
			deckName: 'Default',
			modelName: '',
			fields: {},
			options: {
				allowDuplicate: false,
				duplicateScope: 'deck'
			},
			tags: ['BaseTag']
		},
		EXISTING_IDS: new Set([1001]),
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
		add_obs_tags: false
	}
}

describe('Regression: Template aliasing & mutation isolation', () => {
	it('parsing note 1 does NOT leak tags into note 2 or the shared template', () => {
		const fileData = createDummyFileData()
		const formatter = new FormatConverter({} as any, fileData.vault_name)

		const noteText1 = 'Basic\nFront: Q1\nBack: A1\nTags: tag_only_on_card_1'
		const parsed1 = new Note(noteText1, fileData.fields_dict, false, false, formatter).parse(
			'DeckA',
			'',
			{},
			fileData,
			''
		)

		expect(parsed1.note.tags).toContain('BaseTag')
		expect(parsed1.note.tags).toContain('tag_only_on_card_1')

		// Now parse Note 2 WITHOUT tags
		const noteText2 = 'Basic\nFront: Q2\nBack: A2'
		const parsed2 = new Note(noteText2, fileData.fields_dict, false, false, formatter).parse(
			'DeckB',
			'',
			{},
			fileData,
			''
		)

		// Note 2 must NOT have tag_only_on_card_1
		expect(parsed2.note.tags).toContain('BaseTag')
		expect(parsed2.note.tags).not.toContain('tag_only_on_card_1')

		// Base template must NOT have been mutated
		expect(fileData.template.tags).toEqual(['BaseTag'])
	})

	it('modifying fields on parsed note 1 does not affect note 2', () => {
		const fileData = createDummyFileData()
		const formatter = new FormatConverter({} as any, fileData.vault_name)

		const parsed1 = new Note('Basic\nFront: Q1\nBack: A1', fileData.fields_dict, false, false, formatter).parse(
			'DeckA',
			'',
			{},
			fileData,
			''
		)
		const parsed2 = new Note('Basic\nFront: Q2\nBack: A2', fileData.fields_dict, false, false, formatter).parse(
			'DeckA',
			'',
			{},
			fileData,
			''
		)

		parsed1.note.fields['Front'] = 'MUTATED'
		expect(parsed2.note.fields['Front']).toBe('Q2')
	})
})
