import { describe, it, expect, vi, afterEach } from 'vitest'
import { collectDryRunState, formatDryRunSummary, type DryRunSummary } from '../../src/dry-run'
import { createManagerFiles, createParsedSettings, type DryRunScenario } from './dry-run-helpers'

function invokeForScenario(scenario: DryRunScenario) {
	return vi.fn(async (action: string) => {
		if (action === 'notesInfo') {
			return scenario.notesInfo
		}
		if (action === 'cardsInfo') {
			return scenario.cardsInfo
		}
		throw new Error(`unexpected action in dry-run: ${action}`)
	})
}

describe('collectDryRunState: read-only contract', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('only invokes read actions and never dispatches mutations', async () => {
		const scenario = baseScenario()
		const invokeMock = invokeForScenario(scenario)
		const { setTransport } = await import('../../src/anki')
		setTransport({ invoke: invokeMock })

		const summary = await collectDryRunState([], { hasNoteTypeChanges: false, orphanNoteIds: [] })

		const actions = invokeMock.mock.calls.map((call) => call[0])
		expect(actions).not.toContain('addNote')
		expect(actions).not.toContain('updateNote')
		expect(actions).not.toContain('updateNoteFields')
		expect(actions).not.toContain('updateNoteTags')
		expect(actions).not.toContain('updateNoteModel')
		expect(actions).not.toContain('deleteNotes')
		expect(actions).not.toContain('createDeck')
		expect(actions).not.toContain('storeMediaFile')
		expect(actions).not.toContain('changeDeck')
		expect(actions).not.toContain('sync')
		expect(summary.wouldAdd).toBe(0)
	})
})

function baseScenario(): DryRunScenario {
	return { notesInfo: [], cardsInfo: [] }
}

describe('collectDryRunState: exact diff', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('counts adds, identical notes, field diffs and tag diffs exactly', async () => {
		const { setTransport } = await import('../../src/anki')
		const invokeMock = vi.fn(async (action: string) => {
			if (action === 'notesInfo') {
				return [
					{
						noteId: 11,
						modelName: 'Basic',
						tags: ['keep'],
						fields: { Front: { order: 0, value: 'q1' }, Back: { order: 1, value: 'a1' } },
						cards: [101]
					},
					{
						noteId: 12,
						modelName: 'Basic',
						tags: ['keep'],
						fields: { Front: { order: 0, value: 'q2-CHANGED' }, Back: { order: 1, value: 'a2' } },
						cards: [102]
					},
					{
						noteId: 13,
						modelName: 'Basic',
						tags: ['extra'],
						fields: { Front: { order: 0, value: 'q3' }, Back: { order: 1, value: 'a3' } },
						cards: [103]
					}
				]
			}
			if (action === 'cardsInfo') {
				return [
					{ cardId: 101, deck: 'Default' },
					{ cardId: 102, deck: 'Default' },
					{ cardId: 103, deck: 'Default' }
				]
			}
			throw new Error(`unexpected action in dry-run: ${action}`)
		})
		setTransport({ invoke: invokeMock })
		const files = createManagerFiles(
			createParsedSettings(),
			[
				// identical: Front/Back/tags/deck all match notesInfo + cardsInfo
				{ id: 11, fields: { Front: 'q1', Back: 'a1' }, tags: ['keep'] },
				// field diff
				{ id: 12, fields: { Front: 'q2', Back: 'a2' }, tags: ['keep'] },
				// tag diff (order-insensitive check passes for keeps, extra fails)
				{ id: 13, fields: { Front: 'q3', Back: 'a3' }, tags: ['keep'] }
			],
			[{ deckName: 'Default', modelName: 'Basic' }]
		)

		const summary = await collectDryRunState(files, { hasNoteTypeChanges: false, orphanNoteIds: [] })

		expect(summary.wouldAdd).toBe(1)
		expect(summary.wouldUpdate).toBe(2)
		expect(summary.wouldDelete).toBe(0)
		expect(summary.wouldConvert).toBe(0)
		const updateIds = summary.changes.filter((c) => c.kind === 'update').map((c) => c.noteId)
		expect(updateIds.sort()).toEqual([12, 13])
		// no Anki mutations were dispatched
		for (const call of invokeMock.mock.calls) {
			expect(['notesInfo', 'cardsInfo']).toContain(call[0])
		}
	})

	it('detects deck moves via cardsInfo and converts via model mismatch', async () => {
		const { setTransport } = await import('../../src/anki')
		const invokeMock = vi.fn(async (action: string) => {
			if (action === 'notesInfo') {
				return [
					{
						noteId: 21,
						modelName: 'Basic',
						tags: [],
						fields: { Front: { order: 0, value: 'q' }, Back: { order: 1, value: 'a' } },
						cards: [201]
					},
					{
						noteId: 22,
						modelName: 'Basic',
						tags: [],
						fields: { Text: { order: 0, value: 'c' } },
						cards: [202]
					}
				]
			}
			if (action === 'cardsInfo') {
				return [
					{ cardId: 201, deck: 'OldDeck' },
					{ cardId: 202, deck: 'Default' }
				]
			}
			throw new Error(`unexpected action in dry-run: ${action}`)
		})
		setTransport({ invoke: invokeMock })
		const files = createManagerFiles(
			createParsedSettings(),
			[
				// same fields/tags, but target deck differs from cardsInfo
				{ id: 21, fields: { Front: 'q', Back: 'a' }, tags: [], deck: 'NewDeck', cardIds: [201] },
				// model mismatch -> convert, not update
				{ id: 22, fields: { Text: 'c' }, tags: [], model: 'Cloze', cardIds: [202] }
			],
			[]
		)

		const summary = await collectDryRunState(files, { hasNoteTypeChanges: true, orphanNoteIds: [] })

		expect(summary.wouldUpdate).toBe(1)
		expect(summary.wouldConvert).toBe(1)
		expect(summary.changes.find((c) => c.kind === 'convert')).toMatchObject({
			noteId: 22,
			fromModel: 'Basic',
			toModel: 'Cloze'
		})
	})

	it('reports orphans handed over by the manager without querying Anki', async () => {
		const { setTransport } = await import('../../src/anki')
		const invokeMock = vi.fn(async () => [])
		setTransport({ invoke: invokeMock })

		const summary = await collectDryRunState([], { hasNoteTypeChanges: false, orphanNoteIds: [301, 302] })

		expect(summary.wouldDelete).toBe(2)
		expect(summary.changes.filter((c) => c.kind === 'delete').map((c) => c.noteId)).toEqual([301, 302])
		expect(invokeMock).not.toHaveBeenCalled()
	})
})

describe('formatDryRunSummary', () => {
	it('emits the machine-readable one-liner', () => {
		const summary: DryRunSummary = {
			filesChanged: 2,
			filesTotal: 120,
			wouldAdd: 5,
			wouldUpdate: 1,
			wouldDelete: 0,
			wouldConvert: 1,
			changes: []
		}
		expect(formatDryRunSummary(summary)).toBe(
			'[Obsidian_to_Anki] dry-run complete: files_changed=2/120 would_add=5 would_update=1 would_delete=0 would_convert=1'
		)
	})
})
