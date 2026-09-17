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

	it('trims field values before and after formatting', () => {
		const formatter = new FormatConverter({} as any, 'vault')
		const formatSpy = vi.spyOn(formatter, 'format').mockImplementation((text) => ` [${text}] `)

		const res = formatNoteFields({ Front: '  padded  ' }, 'Basic', false, false, formatter)

		expect(formatSpy).toHaveBeenCalledWith('padded', false, false)
		expect(res.Front).toBe('[padded]')
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

	it('skips frozen-field formatting when the dict is empty', () => {
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
			frozenFieldsDict: {},
			data,
			formatter
		})

		expect(frozenSpy).not.toHaveBeenCalled()
	})

	it('leaves fields alone when url or file-link mapping is missing', () => {
		const formatter = new FormatConverter({} as any, 'vault')

		const noMapping = buildAnkiNote({
			template: createDummyFileData().template,
			modelName: 'Basic',
			fields: { Front: 'Q', Back: 'A' },
			tags: [],
			identifier: null,
			deck: 'Default',
			url: 'obsidian://open?vault=test',
			data: createDummyFileData({ file_link_fields: {} }),
			formatter
		})
		expect(noMapping.note.fields).toEqual({ Front: 'Q', Back: 'A' })

		const noUrl = buildAnkiNote({
			template: createDummyFileData().template,
			modelName: 'Basic',
			fields: { Front: 'Q', Back: 'A' },
			tags: [],
			identifier: null,
			deck: 'Default',
			data: createDummyFileData({ file_link_fields: { Basic: 'Front' } }),
			formatter
		})
		expect(noUrl.note.fields).toEqual({ Front: 'Q', Back: 'A' })
	})

	it('leaves fields alone when context is missing or unmapped', () => {
		const formatter = new FormatConverter({} as any, 'vault')

		const noContext = buildAnkiNote({
			template: createDummyFileData().template,
			modelName: 'Basic',
			fields: { Front: 'Q', Back: 'A' },
			tags: [],
			identifier: null,
			deck: 'Default',
			data: createDummyFileData({ context_fields: { Basic: 'Back' } }),
			formatter
		})
		expect(noContext.note.fields).toEqual({ Front: 'Q', Back: 'A' })

		const noMapping = buildAnkiNote({
			template: createDummyFileData().template,
			modelName: 'Basic',
			fields: { Front: 'Q', Back: 'A' },
			tags: [],
			identifier: null,
			deck: 'Default',
			context: 'Chapter 1',
			data: createDummyFileData({ context_fields: {} }),
			formatter
		})
		expect(noMapping.note.fields).toEqual({ Front: 'Q', Back: 'A' })
	})

	it('strips obsidian tags exactly (no residue, no entity damage)', () => {
		const data = createDummyFileData({ add_obs_tags: true })
		const formatter = new FormatConverter({} as any, 'vault')

		const result = buildAnkiNote({
			template: data.template,
			modelName: 'Basic',
			fields: { Front: 'Question with #medicine tag', Back: 'A &#039; quote' },
			tags: [],
			identifier: null,
			deck: 'Default',
			data,
			formatter
		})

		expect(result.note.fields.Front).toBe('Question with  tag')
		expect(result.note.fields.Back).toBe('A &#039; quote')
		expect(result.note.tags).toContain('medicine')
	})

	it('does not extract tags when add_obs_tags is off, even with tags present', () => {
		const data = createDummyFileData({ add_obs_tags: false })
		const formatter = new FormatConverter({} as any, 'vault')

		const result = buildAnkiNote({
			template: data.template,
			modelName: 'Basic',
			fields: { Front: 'Question with #medicine tag', Back: 'A' },
			tags: ['initial'],
			identifier: null,
			deck: 'Default',
			data,
			formatter
		})

		expect(result.note.fields.Front).toBe('Question with #medicine tag')
		expect(result.note.tags).not.toContain('medicine')
	})

	it('extracts a tag at the very start of a field', () => {
		const data = createDummyFileData({ add_obs_tags: true })
		const formatter = new FormatConverter({} as any, 'vault')

		const result = buildAnkiNote({
			template: data.template,
			modelName: 'Basic',
			fields: { Front: '#leadtag rest', Back: 'A' },
			tags: [],
			identifier: null,
			deck: 'Default',
			data,
			formatter
		})

		expect(result.note.tags).toContain('leadtag')
		expect(result.note.fields.Front).not.toContain('#leadtag')
	})

	it('keeps two-digit cloze markers as valid clozes', () => {
		const data = createDummyFileData()
		const formatter = new FormatConverter({} as any, 'vault')

		for (const text of ['A {{c12::two digits}} deletion', 'A {{c1::with space}} deletion']) {
			const result = buildAnkiNote({
				template: data.template,
				modelName: 'Cloze',
				fields: { Text: text, Extra: 'None' },
				tags: [],
				identifier: 123,
				deck: 'Default',
				data,
				formatter
			})
			expect(result.identifier).toBe(123)
		}
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

	it('keeps an unknown note type on constructor defaults', () => {
		const note = new Note('UnknownModel\nFront: Q\nBack: A', fieldsDict, false, false, formatter)

		expect(note.no_note_type).toBe(true)
		expect(note.field_names).toEqual([])
		expect(note.current_field).toBe('')
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

	it('Note reads an ID without a Tags line', () => {
		const note = new Note('Basic\nFront: Q\nBack: A\n<!--ID: 5-->', fieldsDict, false, false, formatter)

		expect(note.identifier).toBe(5)
		expect(note.tags).toEqual([])
	})

	it('Note reads a bare ID without comment markers', () => {
		const note = new Note('Basic\nFront: Q\nBack: A\nID: 5', fieldsDict, false, false, formatter)

		expect(note.identifier).toBe(5)
	})

	it('Note trims padding around the type line', () => {
		const note = new Note('  Basic  \nFront: Q\nBack: A', fieldsDict, false, false, formatter)

		expect(note.note_type).toBe('Basic')
		expect(note.no_note_type).toBe(false)
	})

	it('Note.getFields joins continuation lines with newlines', () => {
		const note = new Note('Basic\nFront: L1\nL2 tail\nBack: A', fieldsDict, false, false, formatter)
		const fields = note.getFields()

		expect(fields['Front']).toContain('L1')
		expect(fields['Front']).toContain('L2 tail')
		// Without the newline join the two lines would merge into one.
		expect(fields['Front']).toContain('<br')
	})

	it('Note keeps field-like words without a colon in the current field', () => {
		const note = new Note('Basic\nFront: X\nBack pain here\nBack: Y', fieldsDict, false, false, formatter)
		const parsed = note.parse('Default', '', {}, data, '')

		expect(parsed.note.fields.Front).toContain('Back pain here')
		expect(parsed.note.fields.Back).toBe('Y')
	})

	it('Note rejects an ID marker without digits', () => {
		const note = new Note('Basic\nFront: Q\nBack: A\nID: ', fieldsDict, false, false, formatter)

		expect(note.identifier).toBeNull()
	})

	it('Note reads Tags without an ID line', () => {
		const note = new Note('Basic\nFront: Q\nBack: A\nTags: x y', fieldsDict, false, false, formatter)

		expect(note.identifier).toBeNull()
		expect(note.tags).toEqual(['x', 'y'])
	})

	it('InlineNote without ID or Tags keeps text and reports empties', () => {
		const inline = new InlineNote('[Basic] Front: Q Back: A', fieldsDict, false, false, formatter)

		expect(inline.identifier).toBeNull()
		expect(inline.tags).toEqual([])
		expect(inline.note_type).toBe('Basic')
	})

	it('InlineNote strips mid-text tags without leaking them into fields', () => {
		const inline = new InlineNote('[Basic] Front: Q Tags: a b ID: 9', fieldsDict, false, false, formatter)
		const parsed = inline.parse('Default', '', {}, data, '')

		expect(inline.tags).toEqual(['a', 'b'])
		expect(parsed.note.fields.Front).toBe('Q')
		expect(parsed.note.fields.Front).not.toContain('Tags:')
	})

	it('InlineNote without type brackets is marked as unknown note type', () => {
		const inline = new InlineNote('Front: Q Back: A', fieldsDict, false, false, formatter)

		expect(inline.note_type).toBe('')
		expect(inline.no_note_type).toBe(true)
	})

	it('InlineNote trims padding around the type brackets', () => {
		const inline = new InlineNote('[  Basic  ] Front: Q', fieldsDict, false, false, formatter)

		expect(inline.note_type).toBe('Basic')
		expect(inline.no_note_type).toBe(false)
	})

	it('InlineNote ignores field-like words without a colon', () => {
		const inline = new InlineNote('[Basic] Front: X Back pain Back: Y', fieldsDict, false, false, formatter)
		const parsed = inline.parse('Default', '', {}, data, '')

		expect(parsed.note.fields.Front).toContain('Back pain')
		expect(parsed.note.fields.Back).toBe('Y')
	})

	it('InlineNote collects unmarked words into the first field', () => {
		const inline = new InlineNote('[Basic] Just some words', fieldsDict, false, false, formatter)
		const parsed = inline.parse('Default', '', {}, data, '')

		expect(parsed.note.fields.Front).toContain('Just some words')
		expect(parsed.note.fields.Back).toBe('')
	})

	it('RegexNote maps empty captures to empty strings', () => {
		const match = ['whole', '', 'Second', 'Tags: t', '111']
		const regexNote = new RegexNote(match, 'Basic', fieldsDict, true, true, false, false, formatter)

		expect(regexNote.identifier).toBe(111)
		expect(regexNote.tags).toEqual(['t'])

		const parsed = regexNote.parse('MyDeck', '', {}, data, '')
		expect(parsed.note.fields.Front).toBe('')
		expect(parsed.note.fields.Back).toBe('Second')
	})

	it('RegexNote without tags/ID flags reports nulls and ignores extra captures', () => {
		const match = ['whole', 'F1', 'B1']
		const regexNote = new RegexNote(match, 'Basic', fieldsDict, false, false, false, false, formatter)

		expect(regexNote.identifier).toBeNull()
		expect(regexNote.tags).toEqual([])

		const parsed = regexNote.parse('MyDeck', '', {}, data, '')
		expect(parsed.identifier).toBeNull()
		expect(parsed.note.fields.Front).toBe('F1')
		expect(Object.keys(parsed.note.fields).sort()).toEqual(['Back', 'Front'])
	})

	it('RegexNote keeps exact field keys with fewer captures than fields', () => {
		const match = ['whole', 'Only']
		const regexNote = new RegexNote(match, 'Basic', fieldsDict, false, false, false, false, formatter)
		const parsed = regexNote.parse('MyDeck', '', {}, data, '')

		expect(Object.keys(parsed.note.fields).sort()).toEqual(['Back', 'Front'])
		expect(parsed.note.fields.Back).toBe('')
	})

	it('RegexNote surfaces a non-numeric trailing element as NaN, never throws', () => {
		const match = ['whole', 'F', 'B', 'Tags: t', 'not-a-number']
		const regexNote = new RegexNote(match, 'Basic', fieldsDict, true, true, false, false, formatter)

		expect(Number.isNaN(regexNote.identifier)).toBe(true)
		const parsed = regexNote.parse('MyDeck', '', {}, data, '')
		expect(Number.isNaN(parsed.identifier)).toBe(true)
	})
})

describe('context separator literal', () => {
	it('joins appended context with a literal <br>', () => {
		const formatter = new FormatConverter({} as never, 'test-vault')
		const data = {
			template: {
				deckName: 'Default',
				modelName: '',
				fields: {},
				options: { allowDuplicate: true },
				tags: []
			},
			fields_dict: { Basic: ['Front', 'Back'] },
			custom_regexps: {},
			file_link_fields: {},
			context_fields: { Basic: 'Back' },
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
			add_context: true,
			add_obs_tags: false
		} as never
		const note = new Note('Basic\nFront: Q\nBack: A', data.fields_dict, false, false, formatter)
		const parsed = note.parse('Default', '', {}, data, 'Some context')

		expect(parsed.note.fields['Back']).toContain('A<br>Some context')
	})

	it('calls parse without a url (vault links stay out)', () => {
		const formatter = new FormatConverter({} as never, 'test-vault')
		const data = {
			template: {
				deckName: 'Default',
				modelName: '',
				fields: {},
				options: { allowDuplicate: true },
				tags: []
			},
			fields_dict: { Basic: ['Front', 'Back'] },
			custom_regexps: {},
			file_link_fields: { Basic: 'Front' },
			context_fields: {},
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
			add_obs_tags: false
		} as never
		const note = new Note('Basic\nFront: Q\nBack: A', data.fields_dict, false, false, formatter)
		// No url argument: the 4-arg call must not inject any file link.
		const parsed = (
			note as unknown as {
				parse: (
					deck: string,
					url: string,
					frozen: object,
					data: never
				) => { note: { fields: Record<string, string> } }
			}
		).parse('Default', '', {}, data)

		expect(parsed.note.fields['Front']).not.toContain('obsidian://')
	})
})
