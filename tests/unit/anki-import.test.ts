import { describe, it, expect, vi, afterEach } from 'vitest'
import * as AnkiConnect from '../../src/anki'
import {
	applyImport,
	buildImportPlan,
	previewImport,
	type ImportableNote,
	type ImportOptions,
	type ImportVault
} from '../../src/anki-import'
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
				'START\nBasic\nFront: q\nBack: **a**\nTags: Bio\n<!--ID: 1-->\nEND\n\n' +
				'START\nCloze\nText: O {{c1::x}}\nTags: Bio\n<!--ID: 2-->\nEND\n'
		)
	})

	it('leaves the tags Anki sets out of the file', () => {
		const result = plan([basic(1, 'q', 'a', ['leech', 'marked'])])

		expect(result.refused).toEqual([])
		expect(result.files[0].text).toBe('TARGET DECK: Med\n\nSTART\nBasic\nFront: q\nBack: a\n<!--ID: 1-->\nEND\n')
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
			['Cards/Importados/Pai.md', [4]]
		])
		expect(plan(notes.slice(1, 2), 'Outro::Deck').files[0]).toMatchObject({
			path: 'Cards/Importados/Outro Deck/Comum.md',
			deck: 'Outro::Deck'
		})
	})

	it('keeps subjects that differ only in case in one file, named with a capital', () => {
		const notes = [basic(1, 'a', 'b', ['bio']), basic(2, 'c', 'd')]

		const result = buildImportPlan(notes, inDeck(notes), { ...options, subjects: new Map([[2, 'Bio']]) })

		expect(result.files.map((file) => [file.path, file.noteIds])).toEqual([['Cards/Importados/Bio.md', [1, 2]]])
	})

	it('lets a chosen subject override the tags, and never reuses an existing path', () => {
		const notes = [basic(1, 'a', 'b', ['Bio']), basic(2, 'c', 'd')]

		const result = buildImportPlan(notes, inDeck(notes), {
			...options,
			subjects: new Map([
				[1, 'Cardio'],
				[2, 'Cardio'],
				[99, 'Nunca usado']
			]),
			pathExists: (path) => path === 'Cards/Importados/Cardio.md'
		})

		expect(result.files.map((file) => [file.path, file.noteIds])).toEqual([
			['Cards/Importados/Cardio (2).md', [1, 2]]
		])
		expect(result.files[0].text).toContain('Tags: Bio')
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

describe('applyImport', () => {
	const png = Buffer.from('imagem').toString('base64')

	function setup(
		notes: ImportableNote[],
		media: Record<string, string> = {},
		attachments: Record<string, string> = {}
	) {
		const written: string[] = []
		const invoke = vi.fn(async (action: string, params?: Record<string, unknown>) => {
			written.push(action)
			if (action === 'findNotes') {
				return notes.map((note) => note.noteId)
			}
			if (action === 'notesInfo') {
				return notes
			}
			if (action === 'cardsInfo') {
				return (params?.['cards'] as number[]).map((cardId) => ({ cardId, deckName: 'Med' }))
			}
			if (action === 'getMediaFilesNames') {
				return Object.keys(media)
			}
			if (action === 'retrieveMediaFile') {
				return media[params?.['filename'] as string] ?? false
			}
			throw new Error(`must not change Anki: ${action}`)
		})
		AnkiConnect.setTransport({ invoke: invoke as never })
		const vault: ImportVault = {
			createNote: vi.fn(async () => undefined),
			readAttachment: vi.fn(async (name: string) =>
				attachments[name] === undefined ? null : new Uint8Array(Buffer.from(attachments[name])).buffer
			),
			createAttachment: vi.fn(async () => undefined)
		}
		return { vault, invoke }
	}

	it('copies new images, keeps identical ones, and writes the notes without changing Anki', async () => {
		const notes = [basic(1, 'q', '<img src="novo.png"><img src="igual.png">', ['Bio'])]
		const { vault, invoke } = setup(notes, { 'novo.png': png, 'igual.png': png }, { 'igual.png': 'imagem' })

		const result = await applyImport(new Set(), options, vault, 'deck:Med')

		expect(result).toMatchObject({
			blocked: [],
			filesWritten: ['Cards/Importados/Bio.md'],
			notesWritten: 1,
			imagesCopied: 1,
			imagesAlreadyInVault: 1
		})
		expect(vault.createAttachment).toHaveBeenCalledTimes(1)
		expect(Buffer.from(vi.mocked(vault.createAttachment).mock.calls[0][1]).toString()).toBe('imagem')
		expect(vi.mocked(vault.createNote).mock.calls[0][1]).toContain('![[novo.png]]')
		expect(invoke).toHaveBeenCalledWith('findNotes', { query: 'deck:Med' })
	})

	it('skips notes the vault already holds', async () => {
		const { vault } = setup([basic(1, 'q', 'a')])

		const result = await applyImport(new Set([1]), options, vault, 'deck:Med')

		expect(result.notesWritten).toBe(0)
		expect(vault.createNote).not.toHaveBeenCalled()
	})

	it('writes no note when an image is missing from Anki', async () => {
		const { vault } = setup([basic(1, 'q', '<img src="sumiu.png">')])

		const result = await applyImport(new Set(), options, vault, 'deck:Med')

		expect(result.blocked).toEqual(["Image not in Anki's media folder: sumiu.png"])
		expect(vault.createNote).not.toHaveBeenCalled()
		expect(vault.createAttachment).not.toHaveBeenCalled()
	})

	it('writes no note when another file has the same name, and never replaces it', async () => {
		const notes = [basic(1, 'q', '<img src="a.png"><img src="b.png">')]
		const { vault } = setup(notes, { 'a.png': png, 'b.png': png }, { 'a.png': 'outra coisa' })

		const result = await applyImport(new Set(), options, vault, 'deck:Med')

		expect(result.blocked).toEqual(['A different file named a.png is already in the vault.'])
		expect(vault.createNote).not.toHaveBeenCalled()
		expect(vi.mocked(vault.createAttachment).mock.calls.map(([name]) => name)).toEqual(['b.png'])
	})
})
