import { describe, it, expect, vi } from 'vitest'
import * as AnkiConnect from '../../src/anki'
import {
	collectionMetadata,
	difficultCards,
	fieldText,
	getNotes,
	searchNotes,
	studyOverview,
	type VaultRules
} from '../../src/anki-read'

const note = (noteId: number, overrides: Record<string, unknown> = {}) => ({
	noteId,
	modelName: 'Basic',
	tags: ['t'],
	fields: {
		Front: { order: 0, value: `<b>q${noteId}</b>` },
		Back: { order: 1, value: '' }
	},
	cards: [noteId * 10],
	...overrides
})

const card = (cardId: number, overrides: Record<string, unknown> = {}) => ({
	cardId,
	note: Math.floor(cardId / 10),
	deckName: 'Medicina',
	type: 2,
	queue: 2,
	interval: 30,
	factor: 2500,
	reps: 9,
	lapses: 1,
	...overrides
})

/** Answers each action from a table; anything else fails the test. */
function daemon(replies: Record<string, unknown | ((params: Record<string, never>) => unknown)>) {
	const invoke = vi.fn(async (action: string, params?: Record<string, unknown>) => {
		if (!(action in replies)) {
			throw new Error(`unexpected action ${action}`)
		}
		const reply = replies[action]
		return typeof reply === 'function' ? (reply as (p: unknown) => unknown)(params) : reply
	})
	AnkiConnect.setTransport({ invoke })
	return invoke
}

const noSource = () => undefined

describe('fieldText', () => {
	it('keeps what a reader needs and drops the markup', () => {
		expect(fieldText('<ul>\n<li>one</li>\n<li><b>two</b></li>\n</ul>')).toBe('- one\n- two')
		expect(fieldText('a<br />b<br>c')).toBe('a\nb\nc')
		expect(fieldText('x <img alt="y" src="p.png"> z')).toBe('x [image: p.png] z')
		expect(fieldText('{{c1::term}} [sound:a.mp3]')).toBe('{{c1::term}} [sound:a.mp3]')
	})

	it('decodes entities once, so literal text is not mistaken for markup', () => {
		expect(fieldText('TSH &lt; 0,05 &amp;&amp; T4 &gt; 2')).toBe('TSH < 0,05 && T4 > 2')
		expect(fieldText('&amp;lt;')).toBe('&lt;')
		expect(fieldText('a&nbsp;b &quot;c&quot; &#039;d&#39;')).toBe('a b "c" \'d\'')
	})
})

describe('searchNotes', () => {
	it('returns one page of text with cards and source, and the real total', async () => {
		const invoke = daemon({
			findNotes: [1, 2, 3, 4],
			notesInfo: [note(2), note(3)],
			cardsInfo: [card(20), card(30, { queue: -1, type: 0, factor: 0 })]
		})

		const result = await searchNotes({ query: 'tag:t', limit: 2, offset: 1, raw: false }, (id) =>
			id === 2 ? 'a.md' : undefined
		)

		expect(invoke).toHaveBeenCalledWith('notesInfo', { notes: [2, 3] })
		expect(result).toMatchObject({ total: 4, offset: 1, limit: 2 })
		expect(result.notes[0]).toEqual({
			noteId: 2,
			modelName: 'Basic',
			tags: ['t'],
			fields: { Front: 'q2' },
			sourceFile: 'a.md',
			cards: [
				{
					cardId: 20,
					deck: 'Medicina',
					state: 'review',
					suspended: false,
					lapses: 1,
					reps: 9,
					intervalDays: 30,
					easePercent: 250
				}
			]
		})
		expect(result.notes[1]).not.toHaveProperty('sourceFile')
		expect(result.notes[1].cards[0]).toMatchObject({ state: 'new', suspended: true, easePercent: 0 })
	})

	it('returns HTML when asked', async () => {
		daemon({ findNotes: [2], notesInfo: [note(2)], cardsInfo: [card(20)] })

		const result = await searchNotes({ query: '', limit: 5, offset: 0, raw: true }, noSource)

		expect(result.notes[0].fields.Front).toBe('<b>q2</b>')
	})

	it('asks nothing more for an empty result', async () => {
		const invoke = daemon({ findNotes: [] })

		const result = await searchNotes({ query: 'nada', limit: 5, offset: 0, raw: false }, noSource)

		expect(result).toEqual({ total: 0, offset: 0, limit: 5, notes: [] })
		expect(invoke).toHaveBeenCalledTimes(1)
	})

	it('reports a learning interval given in seconds as under a day', async () => {
		daemon({ findNotes: [2], notesInfo: [note(2)], cardsInfo: [card(20, { interval: -600, type: 1 })] })

		const { notes } = await searchNotes({ query: '', limit: 5, offset: 0, raw: false }, noSource)

		expect(notes[0].cards[0]).toMatchObject({ state: 'learning', intervalDays: 0 })
	})

	it('never calls an action that changes the collection', async () => {
		const invoke = daemon({
			findNotes: [2],
			findCards: [20],
			notesInfo: [note(2)],
			cardsInfo: [card(20)],
			getReviewsOfCards: {},
			deckNames: ['D'],
			getDeckStats: {},
			getNumCardsReviewedByDay: [],
			getNumCardsReviewedToday: 0,
			modelNames: [],
			getTags: []
		})

		await searchNotes({ query: '', limit: 1, offset: 0, raw: false }, noSource)
		await getNotes([2], false, noSource)
		await studyOverview(undefined, 1)
		await difficultCards({ minLapses: 1, limit: 1, includeSuspended: false, raw: false }, noSource)
		await collectionMetadata({}, {} as VaultRules)

		const readOnly = /^(find|notesInfo|cardsInfo|get|deckNames|modelNames|modelFieldNames)/
		for (const [action] of invoke.mock.calls) {
			expect(action).toMatch(readOnly)
		}
	})
})

describe('getNotes', () => {
	it('lists the IDs Anki does not know', async () => {
		daemon({ notesInfo: [note(1), {}], cardsInfo: [card(10)] })

		const result = await getNotes([1, 99], false, noSource)

		expect(result.notes.map((n) => n.noteId)).toEqual([1])
		expect(result.missing).toEqual([99])
	})
})

describe('studyOverview', () => {
	const replies = {
		deckNames: ['Medicina', 'Default'],
		getDeckStats: {
			'1': { name: 'Medicina', new_count: 20, learn_count: 7, review_count: 196, total_in_deck: 11077 }
		},
		getNumCardsReviewedByDay: [
			['2026-11-03', 90],
			['2026-11-02', 30]
		],
		getNumCardsReviewedToday: 5
	}

	it('keeps a deck name with a backslash inside its quotes', async () => {
		const invoke = daemon({ ...replies, findCards: [] })

		await studyOverview('abc\\" or deck:* or "x\\', 1)

		expect(invoke).toHaveBeenCalledWith('findCards', {
			query: 'deck:"abc\\\\\\" or deck:* or \\"x\\\\" is:due'
		})
	})

	it('counts within the deck asked for, escaping its name', async () => {
		const invoke = daemon({ ...replies, findCards: [1, 2] })

		const result = await studyOverview('A "B"', 1)

		expect(invoke).toHaveBeenCalledWith('findCards', { query: 'deck:"A \\"B\\"" is:due' })
		expect(invoke).toHaveBeenCalledWith('getDeckStats', { decks: ['A "B"'] })
		expect(result).toMatchObject({
			deck: 'A "B"',
			due: 2,
			reviewedToday: 5,
			reviewsByDay: [{ date: '2026-11-03', cards: 90 }],
			decks: [{ name: 'Medicina', new: 20, learning: 7, review: 196, total: 11077 }]
		})
	})

	it('covers every deck when none is given', async () => {
		const invoke = daemon({ ...replies, findCards: [] })

		await studyOverview(undefined, 30)

		expect(invoke).toHaveBeenCalledWith('findCards', { query: 'deck:* tag:leech' })
		expect(invoke).toHaveBeenCalledWith('getDeckStats', { decks: ['Medicina', 'Default'] })
	})
})

describe('difficultCards', () => {
	it('ranks by lapses, cuts to the limit and sums up the reviews', async () => {
		const invoke = daemon({
			findCards: [10, 20, 30],
			cardsInfo: [card(10, { lapses: 5 }), card(20, { lapses: 9 }), card(30, { lapses: 7 })],
			notesInfo: [note(2), note(3)],
			getReviewsOfCards: {
				'20': [
					{ id: Date.UTC(2026, 0, 1), ease: 1 },
					{ id: Date.UTC(2026, 0, 2), ease: 3 }
				]
			}
		})

		const result = await difficultCards(
			{ deck: 'Medicina', minLapses: 4, limit: 2, includeSuspended: false, raw: false },
			(id) => (id === 2 ? 'a.md' : undefined)
		)

		expect(invoke).toHaveBeenCalledWith('findCards', { query: 'deck:"Medicina" prop:lapses>=4 -is:suspended' })
		expect(result.total).toBe(3)
		expect(result.cards.map((c) => c.cardId)).toEqual([20, 30])
		expect(result.cards[0]).toMatchObject({
			noteId: 2,
			lapses: 9,
			sourceFile: 'a.md',
			fields: { Front: 'q2' },
			reviews: { total: 2, again: 1, lastReviewedAt: '2026-01-02T00:00:00.000Z' }
		})
		expect(result.cards[1].reviews).toEqual({ total: 0, again: 0 })
	})

	it('can include suspended cards and handles no match', async () => {
		const invoke = daemon({ findCards: [], cardsInfo: [], notesInfo: [] })

		const result = await difficultCards({ minLapses: 8, limit: 5, includeSuspended: true, raw: false }, noSource)

		expect(invoke).toHaveBeenCalledWith('findCards', { query: 'deck:* prop:lapses>=8' })
		expect(result).toEqual({ total: 0, cards: [] })
	})
})

describe('collectionMetadata', () => {
	it('marks the note types the plugin cannot sync yet', async () => {
		const rules = { defaultDeck: 'Medicina' } as VaultRules
		const invoke = daemon({
			modelNames: ['Basic', 'New'],
			modelFieldNames: ['Only'],
			deckNames: ['Medicina'],
			getTags: ['t']
		})

		const result = await collectionMetadata({ Basic: ['Front', 'Back'] }, rules)

		expect(result).toEqual({
			decks: ['Medicina'],
			tags: ['t'],
			rules,
			noteTypes: [
				{ name: 'Basic', fields: ['Front', 'Back'], syncable: true },
				{ name: 'New', fields: ['Only'], syncable: false }
			]
		})
		expect(invoke).toHaveBeenCalledWith('modelFieldNames', { modelName: 'New' })
		expect(invoke).not.toHaveBeenCalledWith('modelFieldNames', { modelName: 'Basic' })
	})
})
