import { describe, it, expect } from 'vitest'
import { buildAnkiNote, formatNoteFields } from '../../src/note'
import { FormatConverter } from '../../src/format'
import type { FileData } from '../../src/interfaces/settings-interface'

function createDummyFileData(): FileData {
	return {
		fields_dict: {
			Basic: ['Front', 'Back'],
			Cloze: ['Text', 'Extra']
		},
		custom_regexps: {},
		file_link_fields: { Basic: 'Front', Cloze: 'Text' },
		context_fields: { Basic: 'Back', Cloze: 'Extra' },
		template: {
			deckName: 'Default',
			modelName: '',
			fields: {},
			options: { allowDuplicate: false, duplicateScope: 'deck' },
			tags: ['BaseTag']
		},
		EXISTING_IDS: new Set([1000]),
		vault_name: 'test-vault',
		FROZEN_REGEXP: /FROZEN/g,
		DECK_REGEXP: /TARGET DECK/m,
		TAG_REGEXP: /FILE TAGS/m,
		NOTE_REGEXP: /START[\s\S]*?END/gm,
		INLINE_REGEXP: /STARTI.*?ENDI/g,
		EMPTY_REGEXP: /DELETE/g,
		curly_cloze: true,
		highlights_to_cloze: false,
		comment: true,
		add_context: false,
		add_obs_tags: true
	}
}

describe('Refactor DRY: buildAnkiNote pure composition', () => {
	it('constructs a complete Anki note with context, link, and tags', () => {
		const data = createDummyFileData()
		const formatter = new FormatConverter({} as any, data.vault_name)

		const result = buildAnkiNote({
			template: data.template,
			modelName: 'Basic',
			fields: { Front: 'What is DNA? #biology', Back: 'Genetic material' },
			tags: ['CardTag'],
			identifier: null,
			deck: 'Biology::Genetics',
			url: 'obsidian://open?vault=test&file=notes.md',
			context: 'Biology > Genetics > DNA',
			frozenFieldsDict: {},
			data,
			formatter
		})

		expect(result.identifier).toBeNull()
		expect(result.note.modelName).toBe('Basic')
		expect(result.note.deckName).toBe('Biology::Genetics')
		// URL should be appended to file_link_fields
		expect(result.note.fields['Front']).toContain('class="obsidian-link"')
		// Context should be appended to context_fields
		expect(result.note.fields['Back']).toContain('Biology > Genetics > DNA')
		// Obsidian tag #biology should be stripped from Front and moved to tags
		expect(result.note.fields['Front']).not.toContain('#biology')
		expect(result.note.tags).toContain('biology')
		expect(result.note.tags).toContain('CardTag')
		expect(result.note.tags).toContain('BaseTag')
	})

	it('marks a Cloze note with no clozes in its fields', () => {
		const data = createDummyFileData()
		const formatter = new FormatConverter({} as any, data.vault_name)

		const result = buildAnkiNote({
			template: data.template,
			modelName: 'Cloze',
			fields: { Text: 'This is plain text with no cloze.', Extra: '' },
			tags: [],
			identifier: null,
			deck: 'Default',
			data,
			formatter
		})

		expect(result.problem).toBe('missing-cloze')
		expect(result.identifier).toBeNull()
	})

	it('marks the note type as unknown when the noNoteType flag is set', () => {
		const data = createDummyFileData()
		const formatter = new FormatConverter({} as any, data.vault_name)

		const result = buildAnkiNote({
			template: data.template,
			modelName: 'UnknownModel',
			fields: {},
			tags: [],
			identifier: null,
			deck: 'Default',
			data,
			formatter,
			noNoteType: true
		})

		expect(result.problem).toBe('unknown-type')
	})
})

describe('Refactor DRY: formatNoteFields helper', () => {
	it('formats all field values and applies curly cloze formatting to Cloze models', () => {
		const formatter = new FormatConverter({} as any, 'test-vault')
		const fields = {
			Text: '{c1:Mitochondria} is the {powerhouse} of the cell.',
			Extra: 'Biology fact'
		}

		const formatted = formatNoteFields(fields, 'Cloze', true, false, formatter)
		expect(formatted.Text).toContain('{{c1::Mitochondria}}')
		expect(formatted.Text).toContain('{{c1::powerhouse}}')
	})
})
