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

	it('treats NFC/NFD-equivalent text as identical but keeps case significant', async () => {
		const { setTransport } = await import('../../src/anki')
		const invokeMock = vi.fn(async (action: string) => {
			if (action === 'notesInfo') {
				return [
					{
						// NFC form server-side; local note carries NFD below.
						noteId: 41,
						modelName: 'Basic',
						tags: ['café'],
						fields: { Front: { order: 0, value: 'café' } },
						cards: []
					},
					{
						// Same letters, different case: still a real diff.
						noteId: 42,
						modelName: 'Basic',
						tags: ['keep'],
						fields: { Front: { order: 0, value: 'keep' } },
						cards: []
					}
				]
			}
			throw new Error(`unexpected action in dry-run: ${action}`)
		})
		setTransport({ invoke: invokeMock })
		const files = createManagerFiles(
			createParsedSettings(),
			[
				// NFD 'e' + combining acute: NFC-equal to the Anki side.
				{ id: 41, fields: { Front: 'cafe\u0301' }, tags: ['cafe\u0301'] },
				{ id: 42, fields: { Front: 'Keep' }, tags: ['keep'] }
			],
			[]
		)

		const summary = await collectDryRunState(files, { hasNoteTypeChanges: false, orphanNoteIds: [] })

		expect(summary.wouldUpdate).toBe(1)
		expect(summary.changes.filter((c) => c.kind === 'update').map((c) => c.noteId)).toEqual([42])
		expect(invokeMock.mock.calls.map((call) => call[0])).toEqual(['notesInfo'])
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

	it('pins every skip rule, tag normalization and orphan attribution exactly', async () => {
		const { setTransport } = await import('../../src/anki')
		const invokeMock = vi.fn(async (action: string, params: { notes?: number[]; cards?: number[] }) => {
			if (action === 'notesInfo') {
				expect(params.notes).toEqual([31, 32, 33, 34, 35])
				return [
					{
						noteId: 31,
						modelName: 'Basic',
						tags: ['keep'],
						fields: { Front: { order: 0, value: 'q' }, Back: { order: 1, value: 'a' } },
						cards: []
					},
					{
						noteId: 32,
						modelName: 'Basic',
						tags: ['b', 'a'],
						fields: { Front: { order: 0, value: 'q' } },
						cards: []
					},
					{
						noteId: 33,
						modelName: 'Basic',
						tags: [],
						fields: { Text: { order: 0, value: 'c' } },
						cards: []
					},
					{
						noteId: 35,
						modelName: 'Basic',
						tags: [],
						fields: { Front: { order: 0, value: 'q2' } },
						cards: []
					}
				]
			}
			throw new Error(`unexpected action in dry-run: ${action}`)
		})
		setTransport({ invoke: invokeMock })
		const files = createManagerFiles(
			createParsedSettings(),
			[
				// empty-string local field, missing in Anki: '' matches the ??
				// fallback, so no update (fallback-value pin)
				{ id: 31, fields: { Front: 'q', Back: 'a', Extra: '' }, tags: ['keep'] },
				// same tags in different order plus an empty (dropped by
				// normalization) -> identical (normalization pin)
				{ id: 32, fields: { Front: 'q' }, tags: ['a', '', 'b'], model: 'Basic' },
				// model mismatch with conversions off -> neither convert nor
				// update, even though the field also differs (gating pin)
				{ id: 33, fields: { Text: 'c-local' }, tags: [], model: 'Cloze' },
				// unknown to Anki -> silently skipped
				{ id: 34, fields: { Front: 'q' }, tags: [] },
				// non-empty local field missing in Anki -> update
				// (optional-chain pin: direct access would throw)
				{ id: 35, fields: { Front: 'q2', Extra: 'new' }, tags: [] }
			],
			[{ deckName: 'Default', modelName: 'Basic' }]
		)
		// ID-less edits never reach notesInfo (see the params assertion above).
		files[0].notes_to_edit.push({
			identifier: null,
			note: {
				deckName: 'Default',
				modelName: 'Basic',
				fields: { Front: 'ghost' },
				options: { allowDuplicate: true },
				tags: []
			}
		})

		const summary = await collectDryRunState(files, {
			hasNoteTypeChanges: false,
			orphanNoteIds: [401],
			orphanFileById: new Map([[401, 'gone.md']])
		})

		// No cards anywhere, so cardsInfo is never consulted.
		expect(invokeMock.mock.calls.map((call) => call[0])).toEqual(['notesInfo'])
		expect(summary.wouldAdd).toBe(1)
		expect(summary.wouldUpdate).toBe(1)
		expect(summary.wouldDelete).toBe(1)
		expect(summary.wouldConvert).toBe(0)
		expect(summary.changes).toEqual([
			{ kind: 'add', file: 'dry-run.md', deck: 'Default', modelName: 'Basic' },
			{
				kind: 'update',
				file: 'dry-run.md',
				noteId: 35,
				deck: 'Default',
				modelName: 'Basic',
				fields: ['Front', 'Extra']
			},
			{ kind: 'delete', file: 'gone.md', noteId: 401 }
		])
	})

	it('attributes orphans to an empty file when no map is handed over', async () => {
		const { setTransport } = await import('../../src/anki')
		const invokeMock = vi.fn(async () => [])
		setTransport({ invoke: invokeMock })

		const summary = await collectDryRunState([], { hasNoteTypeChanges: false, orphanNoteIds: [402] })

		expect(summary.changes).toEqual([{ kind: 'delete', file: '', noteId: 402 }])
	})

	it('chunks notesInfo into bounded batches with identical results', async () => {		const { setTransport } = await import('../../src/anki')
		const seen: number[][] = []
		const invokeMock = vi.fn(async (action: string, params: { notes?: number[] }) => {
			if (action === 'notesInfo') {
				seen.push(params.notes ?? [])
				return (params.notes ?? []).map((id) => ({
					noteId: id,
					modelName: 'Basic',
					tags: [],
					fields: {},
					cards: []
				}))
			}
			throw new Error(`unexpected action in dry-run: ${action}`)
		})
		setTransport({ invoke: invokeMock })
		const edits = Array.from({ length: 600 }, (_, i) => ({ id: 1000 + i, fields: {}, tags: [] as string[] }))
		const files = createManagerFiles(createParsedSettings(), edits, [])

		const summary = await collectDryRunState(files, { hasNoteTypeChanges: false, orphanNoteIds: [] })

		expect(seen).toHaveLength(3)
		expect(seen[0]).toHaveLength(256)
		expect(seen[1]).toHaveLength(256)
		expect(seen[2]).toHaveLength(88)
		expect(seen[0][0]).toBe(1000)
		expect(seen[2][87]).toBe(1599)
		expect(summary.wouldUpdate).toBe(0)
		expect(invokeMock.mock.calls.map((call) => call[0])).toEqual(['notesInfo', 'notesInfo', 'notesInfo'])
	})

	it('stops exactly at batch boundaries (no trailing empty batch)', async () => {
		const { setTransport } = await import('../../src/anki')
		const seenNotes: number[][] = []
		const seenCards: number[][] = []
		const invokeMock = vi.fn(async (action: string, params: { notes?: number[]; cards?: number[] }) => {
			if (action === 'notesInfo') {
				seenNotes.push(params.notes ?? [])
				return (params.notes ?? []).map((id) => ({
					noteId: id,
					modelName: 'Basic',
					tags: [],
					fields: {},
					cards: [91000 + (id - 2000) * 3, 91001 + (id - 2000) * 3, 91002 + (id - 2000) * 3]
				}))
			}
			if (action === 'cardsInfo') {
				seenCards.push(params.cards ?? [])
				return (params.cards ?? []).map((cardId) => ({ cardId, deck: 'Default' }))
			}
			throw new Error(`unexpected action in dry-run: ${action}`)
		})
		setTransport({ invoke: invokeMock })
		// Exactly one full notes batch (256); 256 x 3 cards spill cardsInfo
		// into two batches (512 + 256). File targets stay undefined for the
		// synthetic card ids, so the deck check skips them.
		const edits = Array.from({ length: 256 }, (_, i) => ({ id: 2000 + i, fields: {}, tags: [] as string[] }))
		const files = createManagerFiles(createParsedSettings(), edits, [])

		const summary = await collectDryRunState(files, { hasNoteTypeChanges: false, orphanNoteIds: [] })

		expect(seenNotes).toHaveLength(1)
		expect(seenNotes[0]).toHaveLength(256)
		expect(seenCards).toHaveLength(2)
		expect(seenCards[0]).toHaveLength(512)
		expect(seenCards[1]).toHaveLength(256)
		expect(summary.wouldUpdate).toBe(0)
	})

	it('chunks cardsInfo into bounded batches', async () => {
		const { setTransport } = await import('../../src/anki')
		const seen: number[][] = []
		const invokeMock = vi.fn(async (action: string, params: { notes?: number[]; cards?: number[] }) => {
			if (action === 'notesInfo') {
				return [
					{
						noteId: 51,
						modelName: 'Basic',
						tags: [],
						fields: {},
						cards: Array.from({ length: 600 }, (_, i) => 7000 + i)
					}
				]
			}
			if (action === 'cardsInfo') {
				seen.push(params.cards ?? [])
				return (params.cards ?? []).map((cardId) => ({ cardId, deck: 'Default' }))
			}
			throw new Error(`unexpected action in dry-run: ${action}`)
		})
		setTransport({ invoke: invokeMock })
		const files = createManagerFiles(
			createParsedSettings(),
			[{ id: 51, fields: {}, tags: [], cardIds: Array.from({ length: 600 }, (_, i) => 7000 + i) }],
			[]
		)
		// The helper bypasses setup_target_deck (class default ''); align the
		// file target so only chunking — not deck routing — is under test.
		files[0].target_deck = 'Default'

		const summary = await collectDryRunState(files, { hasNoteTypeChanges: false, orphanNoteIds: [] })

		expect(seen).toHaveLength(2)
		expect(seen[0]).toHaveLength(512)
		expect(seen[1]).toHaveLength(88)
		expect(summary.wouldUpdate).toBe(0)
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
