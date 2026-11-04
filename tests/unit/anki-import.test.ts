import { describe, it, expect, vi, afterEach } from 'vitest'
import * as AnkiConnect from '../../src/anki'
import { buildImportPlan, previewImport, type ImportableNote, type ImportOptions } from '../../src/anki-import'
import { createFileData } from '../../src/scan-optimizations'
import { createParsedSettings } from './anki-test-helpers'

afterEach(() => {
	vi.restoreAllMocks()
})

const settings = createParsedSettings({
	fields_dict: { Basic: ['Front', 'Back'], Cloze: ['Text', 'Extra'] },
	curly_cloze: true,
	highlights_to_cloze: true,
	add_obs_tags: true
})

const options: ImportOptions = {
	folder: 'Cards/Importados',
	defaultDeck: 'Med',
	beginNote: 'START',
	reservedWords: ['START', 'END', 'TARGET DECK', 'FILE TAGS', 'Tags: ', 'Front:', 'Back:', 'Text:', 'Extra:'],
	dataFor: (deck) => createFileData(settings, deck, [])
}

function basic(noteId: number, front: string, back: string, tags: string[] = []): ImportableNote {
	return {
		noteId,
		modelName: 'Basic',
		tags,
		cards: [noteId + 1],
		fields: { Front: { value: front, order: 0 }, Back: { value: back, order: 1 } }
	}
}

function cloze(noteId: number, text: string, tags: string[] = []): ImportableNote {
	return {
		noteId,
		modelName: 'Cloze',
		tags,
		cards: [noteId + 1],
		fields: { Text: { value: text, order: 0 }, Extra: { value: '', order: 1 } }
	}
}

const inDeck = (notes: ImportableNote[], deck = 'Med'): Map<number, string> =>
	new Map(notes.flatMap((note) => note.cards.map((card): [number, string] => [card, deck])))

function plan(notes: ImportableNote[], deck = 'Med') {
	return buildImportPlan(notes, inDeck(notes, deck), options)
}

describe('buildImportPlan', () => {
	it('writes blocks that keep the note ID, type and tags', () => {
		const result = plan([basic(1, 'q', '<b>a</b>', ['Bio', 'leech']), cloze(2, 'O {{c1::x}}', ['Bio'])])

		expect(result.refused).toEqual([])
		expect(result.structuralErrors).toBe(0)
		expect(result.files).toHaveLength(1)
		expect(result.files[0].path).toBe('Cards/Importados/Bio.md')
		expect(result.files[0].text).toBe(
			'TARGET DECK: Med\n\n' +
				'START\nBasic\nFront: q\nBack: **a**\nTags: Bio leech\n<!--ID: 1-->\nEND\n\n' +
				'START\nCloze\nText: O {{c1::x}}\nTags: Bio\n<!--ID: 2-->\nEND\n'
		)
	})

	it('groups by most used tag, ignoring tags Anki sets, and folders other decks', () => {
		const notes = [
			basic(1, 'a', 'b', ['Rara', 'Comum']),
			basic(2, 'c', 'd', ['Comum']),
			basic(3, 'e', 'f', ['leech']),
			basic(4, 'g', 'h', ['pai::filho'])
		]

		expect(plan(notes).files.map((file) => [file.path, file.noteIds])).toEqual([
			['Cards/Importados/Comum.md', [1, 2]],
			['Cards/Importados/Sem tag.md', [3]],
			['Cards/Importados/pai.md', [4]]
		])
		expect(plan(notes.slice(1, 2), 'Outro::Deck').files[0]).toMatchObject({
			path: 'Cards/Importados/Outro Deck/Comum.md',
			deck: 'Outro::Deck'
		})
	})

	it('splits a big subject at pauses between study sessions, dating each file', () => {
		const day = 24 * 60 * 60 * 1000
		const start = Date.UTC(2021, 2, 1)
		const notes = [
			...Array.from({ length: 30 }, (_, i) => basic(start + i * 1000, `a${i}`, 'x')),
			...Array.from({ length: 2 }, (_, i) => basic(start + day + i * 1000, `b${i}`, 'x'))
		]

		expect(plan(notes).files.map((file) => [file.path, file.noteIds.length])).toEqual([
			['Cards/Importados/Sem tag 2021-03-01.md', 30],
			['Cards/Importados/Sem tag 2021-03-02.md', 2]
		])
	})

	it('caps a file even without a pause', () => {
		const notes = Array.from({ length: 151 }, (_, i) => basic(1000 + i, `q${i}`, 'x'))

		expect(plan(notes).files.map((file) => file.noteIds.length)).toEqual([150, 1])
	})

	it('refuses what has no Markdown form, keeping the rest', () => {
		const result = plan([basic(1, 'q', '<table><tr><td>x</td></tr></table>'), basic(2, 'q2', 'a')])

		expect(result.refused).toEqual([
			expect.objectContaining({ noteId: 1, reasons: expect.arrayContaining(['no Markdown form for table']) })
		])
		expect(result.files[0].noteIds).toEqual([2])
		expect(result.files[0].text).not.toContain('<!--ID: 1-->')
	})

	it('refuses an image the renderer cannot embed', () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)

		const result = plan([basic(1, 'q', '<img src="a.JPG">'), basic(2, 'q', '<img src="b.jpg">')])

		expect(result.refused).toEqual([expect.objectContaining({ noteId: 1, reasons: ['field Back'] })])
		expect(result.images).toEqual(['b.jpg'])
	})

	it('refuses a note with cards in two decks', () => {
		const note = { ...basic(1, 'q', 'a'), cards: [10, 11] }

		const result = buildImportPlan(
			[note],
			new Map([
				[10, 'A'],
				[11, 'B']
			]),
			options
		)

		expect(result.refused[0].reasons).toEqual(['cards in more than one deck'])
		expect(result.files).toEqual([])
	})

	it('survives text the block parser would read as structure', () => {
		const result = plan([
			basic(1, 'ENDOMETRIOSE', 'Back: x<br>START<br>Tags: y<br>Front: z<br>nota #1'),
			cloze(2, 'END {{c1::a}}<br>Extra: b<br>{c}')
		])

		expect(result.refused).toEqual([])
		expect(result.structuralErrors).toBe(0)
		expect(result.files[0].noteIds).toEqual([1, 2])
	})

	it('counts images and what would change only in looks', () => {
		const result = plan([
			basic(1, 'q', '<img src="a.png" width="30" alt="x"><img src="https://x.org/b.png">'),
			basic(2, 'q2', '<img src="a.png"> <span style="color: red">t</span>')
		])

		expect(result.images).toEqual(['a.png'])
		expect(result.externalImages).toBe(1)
		expect(result.cosmeticChanges).toEqual({ imageWidth: 0, imageAlt: 1, inlineStyle: 1 })
	})
})

describe('previewImport', () => {
	function daemon(notes: Array<ImportableNote & { modelName: string }>) {
		const invoke = vi.fn(async (action: string, params?: Record<string, unknown>) => {
			if (action === 'findNotes') {
				return notes.map((note) => note.noteId)
			}
			if (action === 'notesInfo') {
				return notes.filter((note) => (params?.['notes'] as number[]).includes(note.noteId))
			}
			if (action === 'cardsInfo') {
				return (params?.['cards'] as number[]).map((cardId) => ({ cardId, deckName: 'Med' }))
			}
			throw new Error(`not read-only: ${action}`)
		})
		AnkiConnect.setTransport({ invoke: invoke as never })
		return invoke
	}

	it('skips notes in the vault, leaves occlusions in Anki, and only reads', async () => {
		const invoke = daemon([
			basic(1, 'já no vault', 'a'),
			basic(2, 'q', 'a', ['Bio']),
			{ ...basic(3, 'q', 'a'), modelName: 'Image Occlusion Enhanced' },
			{ ...basic(4, 'q', 'a'), modelName: 'Cloze (overlapping)' }
		])

		const preview = await previewImport(new Set([1]), options)

		expect(preview).toMatchObject({
			candidates: 1,
			ready: 1,
			refused: [],
			leftInAnki: { 'Image Occlusion Enhanced': 1, 'Cloze (overlapping)': 1 },
			files: [{ path: 'Cards/Importados/Bio.md', deck: 'Med', notes: 1 }],
			imageCount: 0,
			structuralErrors: 0
		})
		expect(new Set(invoke.mock.calls.map(([action]) => action))).toEqual(
			new Set(['findNotes', 'notesInfo', 'cardsInfo'])
		)
	})

	it('copes with nothing to import', async () => {
		daemon([])

		await expect(previewImport(new Set(), options)).resolves.toMatchObject({ candidates: 0, ready: 0, files: [] })
	})
})
