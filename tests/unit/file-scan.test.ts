import { describe, it, expect } from 'vitest'
import type { CachedMetadata } from 'obsidian'
import { AllFile } from '../../src/file'
import { escapeRegex } from '../../src/constants'
import { ID_REGEXP_STR } from '../../src/note'
import type { FileData } from '../../src/interfaces/settings-interface'
import type { AnkiConnectNote } from '../../src/interfaces/note-interface'

function buildFileData(overrides: Partial<FileData> = {}): FileData {
	const template: AnkiConnectNote = {
		deckName: 'Default',
		modelName: '',
		fields: {},
		options: {
			allowDuplicate: true
		},
		tags: ['Obsidian_to_Anki']
	}
	return {
		fields_dict: { Basic: ['Front', 'Back'] },
		custom_regexps: {},
		file_link_fields: {},
		context_fields: {},
		template,
		EXISTING_IDS: new Set<number>(),
		vault_name: 'test-vault',
		FROZEN_REGEXP: new RegExp(escapeRegex('FROZEN') + String.raw` - (.*?):\n((?:[^\n][\n]?)+)`, 'g'),
		DECK_REGEXP: new RegExp(String.raw`^` + escapeRegex('TARGET DECK') + String.raw`(?:\n|: )(.*)`, 'm'),
		TAG_REGEXP: new RegExp(String.raw`^` + escapeRegex('FILE TAGS') + String.raw`(?:\n|: )(.*)`, 'm'),
		NOTE_REGEXP: new RegExp(
			String.raw`^` +
				escapeRegex('START') +
				String.raw`[ ]*\n([\s\S]*?\n)` +
				escapeRegex('END') +
				String.raw`[ ]*`,
			'gm'
		),
		INLINE_REGEXP: new RegExp(escapeRegex('STARTI') + String.raw`(.*?)` + escapeRegex('ENDI'), 'g'),
		EMPTY_REGEXP: new RegExp(escapeRegex('DELETE') + ID_REGEXP_STR, 'g'),
		curly_cloze: false,
		highlights_to_cloze: false,
		comment: true,
		add_context: false,
		add_obs_tags: false,
		...overrides
	}
}

const emptyCache = {} as CachedMetadata

function scan(content: string, data?: FileData): AllFile {
	const file = new AllFile(content, 'note.md', '', data ?? buildFileData(), emptyCache)
	file.scanFile()
	return file
}

describe('AllFile.scanFile end-to-end', () => {
	it('parses a basic START/END block into notes_to_add', () => {
		const file = scan('START\nBasic\nFront: What is 2+2?\nBack: 4\nEND')
		expect(file.notes_to_add).toHaveLength(1)
		expect(file.all_notes_to_add).toHaveLength(1)
		const note = file.notes_to_add[0]
		expect(note.modelName).toBe('Basic')
		expect(note.deckName).toBe('Default')
		expect(note.fields['Front']).toContain('What is 2+2?')
		expect(note.fields['Back']).toContain('4')
	})

	it('appends FILE TAGS to new notes', () => {
		const file = scan('FILE TAGS: review hard\nSTART\nBasic\nFront: Q\nBack: A\nEND')
		expect(file.notes_to_add).toHaveLength(1)
		expect(file.notes_to_add[0].tags).toContain('review')
		expect(file.notes_to_add[0].tags).toContain('hard')
	})

	it('locks the whole file to a frontmatter TARGET DECK', () => {
		const file = scan('---\nTARGET DECK: Medicina\n---\nSTART\nBasic\nFront: Q\nBack: A\nEND')
		expect(file.notes_to_add).toHaveLength(1)
		expect(file.notes_to_add[0].deckName).toBe('Medicina')
	})

	it('routes cards to body TARGET DECK declarations by position', () => {
		const file = scan(
			'TARGET DECK: DeckA\nSTART\nBasic\nFront: Q1\nBack: A1\nEND\nTARGET DECK: DeckB\nSTART\nBasic\nFront: Q2\nBack: A2\nEND'
		)
		expect(file.notes_to_add).toHaveLength(2)
		expect(file.notes_to_add[0].deckName).toBe('DeckA')
		expect(file.notes_to_add[1].deckName).toBe('DeckB')
	})

	it('routes existing IDs to notes_to_edit instead of notes_to_add', () => {
		const data = buildFileData({ EXISTING_IDS: new Set([777]) })
		const file = scan('START\nBasic\nFront: Q\nBack: A\n<!--ID: 777-->\nEND', data)
		expect(file.notes_to_add).toHaveLength(0)
		expect(file.notes_to_edit).toHaveLength(1)
		expect(file.notes_to_edit[0].identifier).toBe(777)
	})

	it('warns and skips notes whose ID does not exist in Anki', () => {
		const file = scan('START\nBasic\nFront: Q\nBack: A\n<!--ID: 999999-->\nEND')
		expect(file.notes_to_add).toHaveLength(0)
		expect(file.notes_to_edit).toHaveLength(0)
	})

	it('parses inline STARTI/ENDI notes', () => {
		const file = scan('Some text STARTI[Basic] Front: Qi Back: AiENDI more text')
		expect(file.inline_notes_to_add).toHaveLength(1)
		expect(file.all_notes_to_add).toHaveLength(1)
		expect(file.inline_notes_to_add[0].modelName).toBe('Basic')
	})

	it('collects DELETE lines into notes_to_delete', () => {
		const file = scan('START\nBasic\nFront: Q\nBack: A\nEND\nDELETE\nID: 555')
		expect(file.notes_to_delete).toEqual([555])
	})

	it('leaves ignore_spans empty when no custom regexps are configured', () => {
		const file = scan('START\nBasic\nFront: Q\nBack: A\nEND')
		expect(file.ignore_spans).toEqual([])
	})

	it('writeIDs inserts comment IDs back into the file', () => {
		const file = scan('START\nBasic\nFront: Q\nBack: A\nEND')
		file.note_ids = [123]
		file.writeIDs()
		expect(file.file).toContain('<!--ID: 123-->')
	})

	it('writeIDs zips note_ids positionally across regular, inline and regexp adds', () => {
		const content = [
			'START',
			'Basic',
			'Front: Q1',
			'Back: A1',
			'END',
			'Some text STARTI[Basic] Front: Qi Back: AiENDI more text',
			'Q::qr',
			'A::ar'
		].join('\n')
		const file = scan(content, buildFileData({ custom_regexps: { Basic: 'Q::(.*?)\\nA::(.*)' } }))

		expect(file.notes_to_add).toHaveLength(1)
		expect(file.inline_notes_to_add).toHaveLength(1)
		expect(file.regex_notes_to_add).toHaveLength(1)
		expect(file.pendingAdds.map((add) => add.kind)).toEqual(['note', 'inline', 'regex'])

		file.note_ids = [11, 22, 33]
		file.writeIDs()

		expect(file.file).toContain('Back: A1\n<!--ID: 11-->\n')
		expect(file.file).toContain('Ai<!--ID: 22--> ENDI')
		expect(file.file).toContain('A::ar\n<!--ID: 33-->\n')
	})
})
