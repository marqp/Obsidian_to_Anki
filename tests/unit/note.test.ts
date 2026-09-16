import { describe, it, expect, vi } from 'vitest'
import {
	Note,
	InlineNote,
	RegexNote,
	cloneTemplate,
	formatNoteFields,
	buildAnkiNote,
	CLOZE_ERROR,
	NOTE_TYPE_ERROR
} from '../../src/note'
import { FormatConverter } from '../../src/format'
import type { FileData } from '../../src/interfaces/settings-interface'
import type { AnkiConnectNote } from '../../src/interfaces/note-interface'

function createDummyFileData(overrides: Partial<FileData> = {}): FileData {
	const baseTemplate: AnkiConnectNote = {
		deckName: 'Default',
		modelName: 'Basic',
		fields: { Front: '', Back: '' },
		options: { allowDuplicate: true },
		tags: ['Obsidian_to_Anki']
	}
	return {
		fields_dict: {
			Basic: ['Front', 'Back'],
			Cloze: ['Text', 'Extra']
		},
		custom_regexps: {},
		file_link_fields: {},
		context_fields: {},
		template: baseTemplate,
		EXISTING_IDS: new Set([100, 200]),
		vault_name: 'test-vault',
		FROZEN_REGEXP: /dummy/g,
		DECK_REGEXP: /dummy/m,
		TAG_REGEXP: /dummy/m,
		NOTE_REGEXP: /dummy/gm,
		INLINE_REGEXP: /dummy/g,
		EMPTY_REGEXP: /dummy/g,
		curly_cloze: true,
		highlights_to_cloze: true,
		comment: true,
		add_context: false,
		add_obs_tags: false,
		...overrides
	}
}

describe('Note logic: cloneTemplate', () => {
	it('deeply clones fields, options, and tags', () => {
		const original: AnkiConnectNote = {
			deckName: 'Deck1',
			modelName: 'Basic',
			fields: { Front: 'F', Back: 'B' },
			options: { allowDuplicate: false },
			tags: ['t1']
		}
		const clone = cloneTemplate(original)

		expect(clone).toEqual(original)
		clone.fields.Front = 'Changed'
		clone.tags.push('t2')
		clone.options.allowDuplicate = true

		expect(original.fields.Front).toBe('F')
		expect(original.tags).toEqual(['t1'])
		expect(original.options.allowDuplicate).toBe(false)
	})
})

describe('Note logic: formatNoteFields', () => {
	it('formats cloze fields only when model is cloze and curlyCloze is enabled', () => {
		const formatter = new FormatConverter({} as any, 'vault')
		const formatSpy = vi.spyOn(formatter, 'format').mockImplementation((text) => `formatted:${text}`)

		const fields = { Text: 'content' }
		const res = formatNoteFields(fields, 'Cloze', true, false, formatter)

		expect(formatSpy).toHaveBeenCalledWith('content', true, false)
		expect(res.Text).toBe('formatted:content')

		formatSpy.mockClear()
		formatNoteFields({ Front: 'q' }, 'Basic', true, false, formatter)
		expect(formatSpy).toHaveBeenCalledWith('q', false, false)

		formatSpy.mockClear()
		formatNoteFields({ Text: 'c' }, 'Cloze', false, false, formatter)
		expect(formatSpy).toHaveBeenCalledWith('c', false, false)
	})
})

describe('Note logic: buildAnkiNote', () => {
	it('returns NOTE_TYPE_ERROR when noNoteType is true', () => {
		const data = createDummyFileData()
		const formatter = new FormatConverter({} as any, 'vault')

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

		expect(result.identifier).toBe(NOTE_TYPE_ERROR)
		expect(result.note.modelName).toBe('UnknownModel')
	})

	it('validates cloze deletions for Cloze models', () => {
		const data = createDummyFileData()
		const formatter = new FormatConverter({} as any, 'vault')

		// Missing cloze deletion in fields
		const missingCloze = buildAnkiNote({
			template: data.template,
			modelName: 'Cloze',
			fields: { Text: 'No cloze here', Extra: 'None' },
			tags: [],
			identifier: 123,
			deck: 'Default',
			data,
			formatter
		})
		expect(missingCloze.identifier).toBe(CLOZE_ERROR)

		// Valid cloze deletion present
		const validCloze = buildAnkiNote({
			template: data.template,
			modelName: 'Cloze',
			fields: { Text: 'A {{c1::cloze}} deletion', Extra: 'None' },
			tags: [],
			identifier: 123,
			deck: 'Default',
			data,
			formatter
		})
		expect(validCloze.identifier).toBe(123)
	})

	it('appends context and file link when configured', () => {
		const data = createDummyFileData({
			file_link_fields: { Basic: 'Front' },
			context_fields: { Basic: 'Back' }
		})
		const formatter = new FormatConverter({} as any, 'vault')
		vi.spyOn(formatter, 'format_note_with_url').mockImplementation((note, url, field) => {
			note.fields[field] = `<a href="${url}">link</a>`
		})

		const result = buildAnkiNote({
			template: data.template,
			modelName: 'Basic',
			fields: { Front: 'Q', Back: 'A' },
			tags: ['tag1'],
			identifier: null,
			deck: 'TargetDeck',
			url: 'obsidian://open?vault=test',
			context: 'Chapter 1 > Topic A',
			data,
			formatter
		})

		expect(result.note.deckName).toBe('TargetDeck')
		expect(result.note.fields.Front).toBe('<a href="obsidian://open?vault=test">link</a>')
		expect(result.note.fields.Back).toBe('A<br>Chapter 1 > Topic A')
		expect(result.note.tags).toContain('tag1')
	})

	it('extracts obsidian #tags from fields when add_obs_tags is true', () => {
		const data = createDummyFileData({ add_obs_tags: true })
		const formatter = new FormatConverter({} as any, 'vault')

		const result = buildAnkiNote({
			template: data.template,
			modelName: 'Basic',
			fields: { Front: 'Question with #medicine tag', Back: 'Answer with #neuro/brain tag' },
			tags: ['initial'],
			identifier: null,
			deck: 'Default',
			data,
			formatter
		})

		expect(result.note.tags).toContain('medicine')
		expect(result.note.tags).toContain('neuro/brain')
		expect(result.note.fields.Front).not.toContain('#medicine')
		expect(result.note.fields.Back).not.toContain('#neuro/brain')
	})

	it('ignores HTML entities while keeping unicode/hyphen tags (upstream #537 superseded)', () => {
		const data = createDummyFileData({ add_obs_tags: true })
		const formatter = new FormatConverter({} as any, 'vault')

		const result = buildAnkiNote({
			template: data.template,
			modelName: 'Basic',
			fields: { Front: 'It&#039;s #biología-tag here &#123;', Back: 'plain' },
			tags: [],
			identifier: null,
			deck: 'Default',
			data,
			formatter
		})

		expect(result.note.tags).toContain('biología-tag')
		expect(result.note.tags).not.toContain('039;')
		expect(result.note.tags).not.toContain('123;')
		expect(result.note.fields.Front).not.toContain('#biología-tag')
		expect(result.note.fields.Front).toContain('&#039;')
	})

	it('formats frozen fields when provided', () => {
		const data = createDummyFileData()
		const formatter = new FormatConverter({} as any, 'vault')
		const frozenSpy = vi.spyOn(formatter, 'format_note_with_frozen_fields')

		buildAnkiNote({
			template: data.template,
			modelName: 'Basic',
			fields: { Front: 'Q', Back: 'A' },
			tags: [],
			identifier: null,
			deck: 'Default',
			frozenFieldsDict: { Basic: { Extra: 'Frozen' } },
			data,
			formatter
		})

		expect(frozenSpy).toHaveBeenCalledWith(expect.any(Object), { Basic: { Extra: 'Frozen' } })
	})
})

describe('Note classes: Note, InlineNote, RegexNote', () => {
	const fieldsDict = {
		Basic: ['Front', 'Back'],
		Cloze: ['Text', 'Extra']
	}
	const data = createDummyFileData({ fields_dict: fieldsDict })
	const formatter = new FormatConverter({} as any, 'vault')

	it('Note parses standard multiline cards with ID and Tags', () => {
		const text = `Basic\nFront: Capital of France?\nBack: Paris\nTags: geo europe\n<!--ID: 555-->`
		const note = new Note(text, fieldsDict, true, true, formatter)

		expect(note.note_type).toBe('Basic')
		expect(note.identifier).toBe(555)
		expect(note.tags).toEqual(['geo', 'europe'])
		expect(note.no_note_type).toBe(false)

		const parsed = note.parse('Geography', '', {}, data, '')
		expect(parsed.identifier).toBe(555)
		expect(parsed.note.fields.Front).toBe('Capital of France?')
		expect(parsed.note.fields.Back).toBe('Paris')
		expect(parsed.note.deckName).toBe('Geography')
	})

	it('Note handles unrecognized note type safely', () => {
		const text = `UnknownModel\nFront: Q\nBack: A`
		const note = new Note(text, fieldsDict, true, true, formatter)

		expect(note.no_note_type).toBe(true)
		const parsed = note.parse('Default', '', {}, data, '')
		expect(parsed.identifier).toBe(NOTE_TYPE_ERROR)
	})

	it('InlineNote parses single-line format', () => {
		const text = `[Basic] What is DNA? Back: Genetic material Tags: biology ID: 777`
		const inline = new InlineNote(text, fieldsDict, true, true, formatter)

		expect(inline.note_type).toBe('Basic')
		expect(inline.identifier).toBe(777)
		expect(inline.tags).toEqual(['biology'])
	})

	it('RegexNote parses capture groups and maps them to fields', () => {
		const match = ['whole match', 'First Field Content', 'Second Field Content', 'Tags: tagA', '999']
		const regexNote = new RegexNote(match, 'Basic', fieldsDict, true, true, true, false, formatter)

		expect(regexNote.identifier).toBe(999)
		expect(regexNote.tags).toEqual(['tagA'])

		const parsed = regexNote.parse('MyDeck', '', {}, data, '')
		expect(parsed.identifier).toBe(999)
		expect(parsed.note.fields.Front).toBe('First Field Content')
		expect(parsed.note.fields.Back).toBe('Second Field Content')
	})
})
