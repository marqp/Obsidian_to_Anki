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

	it('custom-regexp search extracts trailing Tags lines', () => {
		const file = scan(
			'Q::qr\nA::ar Tags: mytag',
			buildFileData({ custom_regexps: { Basic: 'Q::(.*?)\\nA::(.*)' } })
		)

		expect(file.regex_notes_to_add).toHaveLength(1)
		expect(file.regex_notes_to_add[0].tags).toContain('mytag')
		// Without the `(Tags: .*)` group the match would slice 'ar Tags: mytag'
		// as the tag source, leaking a 's:' fragment (upstream #537 area).
		expect(file.regex_notes_to_add[0].tags).not.toContain('s:')
	})
})

describe('AllFile.parseIssues: notes the scan cannot sync are reported', () => {
	const clozeData = (): FileData =>
		buildFileData({ fields_dict: { Basic: ['Front', 'Back'], Cloze: ['Text', 'Extra'] } })

	it('reports a Cloze block without deletions, with its line and text', () => {
		const file = scan('# Heading\n\nSTART\nCloze\nPlain text\nBack:\n- a list\nEND\n', clozeData())

		expect(file.notes_to_add).toEqual([])
		expect(file.parseIssues).toEqual([
			expect.objectContaining({
				file: 'note.md',
				kind: 'cloze-without-deletions',
				line: 3,
				snippet: 'Cloze Plain text Back: - a list'
			})
		])
	})

	describe('Image Occlusion blocks', () => {
		const MASK = '{{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.1:oi=1}}'
		const occlusionData = (): FileData =>
			buildFileData({
				fields_dict: { 'Image Occlusion': ['Occlusion', 'Image', 'Header', 'Back Extra', 'Comments'] },
				curly_cloze: true,
				highlights_to_cloze: true
			})
		const block = (lines: string[]): string => ['START', 'Image Occlusion', ...lines, 'END', ''].join('\n')

		it('sends one with masks and an image, leaving the masks as written', () => {
			const file = scan(block([`Occlusion: ${MASK}`, 'Image: <img src="a.png">']), occlusionData())

			expect(file.parseIssues).toEqual([])
			expect(file.notes_to_add[0].fields['Occlusion']).toBe(MASK)
		})

		it('accepts an embedded image that the metadata cache has not resolved', () => {
			const file = scan(block([`Occlusion: ${MASK}`, 'Image: ![[a.png|879]]']), occlusionData())

			expect(file.parseIssues).toEqual([])
			expect(file.notes_to_add).toHaveLength(1)
		})

		it.each([
			['no mask', ['Occlusion: {{c1::just text}}', 'Image: <img src="a.png">'], 'at least one'],
			['no image', [`Occlusion: ${MASK}`, 'Header: q'], 'an image is required'],
			[
				'a mask outside the image',
				['Occlusion: {{c1::image-occlusion:rect:left=.9:top=.2:width=.3:height=.1}}', 'Image: ![[a.png]]'],
				'c1 rect leaves the image'
			]
		])('reports one with %s and does not send it', (_case, lines, reason) => {
			const file = scan(block(lines), occlusionData())

			expect(file.notes_to_add).toEqual([])
			expect(file.parseIssues).toEqual([
				expect.objectContaining({
					kind: 'cloze-without-deletions',
					error: expect.stringContaining(reason)
				})
			])
		})

		describe('with the vault to ask', () => {
			const inVault = (...links: string[]): FileData => ({
				...occlusionData(),
				mediaExists: (link) => links.includes(link)
			})

			it('sends a new note whose image is in the vault', () => {
				const file = scan(block([`Occlusion: ${MASK}`, 'Image: ![[pasta/a.png|879]]']), inVault('pasta/a.png'))

				expect(file.parseIssues).toEqual([])
				expect(file.notes_to_add).toHaveLength(1)
			})

			it('does not create a note whose image is not there, and names it', () => {
				const file = scan(block([`Occlusion: ${MASK}`, 'Image: ![[a.png]]']), inVault())

				expect(file.notes_to_add).toEqual([])
				expect(file.parseIssues).toEqual([
					expect.objectContaining({
						kind: 'occlusion-image-missing',
						line: 1,
						error: expect.stringContaining('a.png')
					})
				])
			})

			it('leaves a note with an ID as it is in Anki, and still counts it as present', () => {
				const data = { ...inVault(), EXISTING_IDS: new Set([1234]) }
				const file = scan(block([`Occlusion: ${MASK}`, 'Image: ![[a.png]]', '<!--ID: 1234-->']), data)

				expect(file.notes_to_edit).toEqual([])
				expect(file.getNoteIdsInFile()).toEqual([1234])
				expect(file.parseIssues).toEqual([
					expect.objectContaining({ kind: 'occlusion-image-missing', noteId: 1234 })
				])
			})

			it('reports the mask first when the block has both problems', () => {
				const file = scan(block(['Occlusion: {{c1::just text}}', 'Image: ![[a.png]]']), inVault())

				expect(file.parseIssues).toEqual([expect.objectContaining({ kind: 'cloze-without-deletions' })])
			})

			it('checks only occlusions', () => {
				const data = { ...inVault(), fields_dict: { Basic: ['Front', 'Back'] } }
				const file = scan('START\nBasic\nFront: q ![[a.png]]\nBack: a\nEND\n', data)

				expect(file.parseIssues).toEqual([])
				expect(file.notes_to_add).toHaveLength(1)
			})
		})
	})

	it('names the existing note when a Cloze block with an ID lost its deletions', () => {
		const file = scan('START\nCloze\nPlain text\n<!--ID: 1234-->\nEND\n', clozeData())

		expect(file.parseIssues[0]).toMatchObject({ kind: 'cloze-without-deletions', noteId: 1234 })
	})

	it('reports an unknown note type', () => {
		const file = scan('START\nNoSuchType\nFront: q\nEND\n')

		expect(file.parseIssues).toEqual([
			expect.objectContaining({
				kind: 'unknown-note-type',
				line: 1,
				error: expect.stringContaining('NoSuchType')
			})
		])
	})

	it('reports an ID Anki does not know', () => {
		const file = scan('START\nBasic\nFront: q\nBack: a\n<!--ID: 99-->\nEND\n')

		expect(file.parseIssues).toEqual([expect.objectContaining({ kind: 'stale-note-id', noteId: 99 })])
	})

	it('reports the second block that reuses an ID, and still parses both as before', () => {
		const data = buildFileData({ EXISTING_IDS: new Set([7]) })
		const block = (front: string): string => `START\nBasic\nFront: ${front}\nBack: a\n<!--ID: 7-->\nEND\n`
		const file = scan(`${block('first')}\n${block('second')}`, data)

		expect(file.notes_to_edit).toHaveLength(2)
		expect(file.parseIssues).toEqual([
			expect.objectContaining({
				kind: 'duplicate-note-id',
				noteId: 7,
				line: 8,
				snippet: expect.stringContaining('second')
			})
		])
	})

	it('stays silent for notes that sync normally', () => {
		const data = buildFileData({ EXISTING_IDS: new Set([7]) })
		const file = scan(
			'START\nBasic\nFront: new\nBack: a\nEND\n\nSTART\nBasic\nFront: q\nBack: a\n<!--ID: 7-->\nEND\n',
			data
		)

		expect(file.parseIssues).toEqual([])
	})

	it('starts clean when the same file is scanned again', () => {
		const file = scan('START\nNoSuchType\nFront: q\nEND\n')
		file.scanFile()

		expect(file.parseIssues).toHaveLength(1)
	})
})

describe('AllFile note lines, for reports', () => {
	it('locates new and existing notes', () => {
		const data = buildFileData({ EXISTING_IDS: new Set([7]) })
		const file = scan('# H\n\nSTART\nBasic\nFront: new\nEND\n\nSTART\nBasic\nFront: old\n<!--ID: 7-->\nEND\n', data)

		expect(file.addedNoteLine(0)).toBe(3)
		expect(file.addedNoteLine(1)).toBeUndefined()
		expect(file.editedNoteLine(7)).toBe(8)
		expect(file.editedNoteLine(8)).toBeUndefined()
	})
})
