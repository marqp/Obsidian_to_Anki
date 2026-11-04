import * as AnkiConnect from './anki'

/*
 * Read-only views of the Anki collection for the local API. Nothing here may
 * call an action that changes the collection: Markdown owns the cards, and an
 * edit made directly in Anki would be overwritten by the next sync.
 */

const NOTES_INFO_BATCH_SIZE = 256
const CARDS_INFO_BATCH_SIZE = 512
const ANKI_AGAIN_EASE = 1
const SUSPENDED_QUEUE = -1
const SECONDS_PER_DAY = 86_400
const CARD_STATES = ['new', 'learning', 'review', 'relearning']

interface RawNote {
	noteId: number
	modelName: string
	tags: string[]
	fields: Record<string, { order: number; value: string }>
	cards: number[]
	mod?: number
}

interface RawCard {
	cardId: number
	note: number
	ord: number
	deckName: string
	type: number
	queue: number
	interval: number
	factor: number
	reps: number
	lapses: number
}

interface RawReview {
	id: number
	ease: number
}

/** Which vault file carries a note, when it is tracked by this plugin. */
export type SourceLookup = (noteId: number) => string | undefined

interface CardView {
	cardId: number
	/** The card's number within its note. In a cloze or occlusion note it answers to cN, where N = ord + 1. */
	ord: number
	deck: string
	state: string
	suspended: boolean
	lapses: number
	reps: number
	/** Days until the next review once the card has graduated; 0 while learning. */
	intervalDays: number
	/** Ease as a percentage (250 = 250%); 0 for new cards. */
	easePercent: number
}

export interface NoteView {
	noteId: number
	modelName: string
	tags: string[]
	/** Field text; empty fields are left out. */
	fields: Record<string, string>
	/** Vault file holding this note; absent when it exists only in Anki. */
	sourceFile?: string
	cards: CardView[]
}

export interface NoteSearch {
	query: string
	limit: number
	offset: number
	/** Field HTML instead of plain text. */
	raw: boolean
}

const ENTITIES: Record<string, string> = {
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&#039;': "'",
	'&#39;': "'",
	'&nbsp;': ' ',
	'&amp;': '&'
}

/**
 * A field's text for a model to read: images keep their file name and list
 * items their markers, the markup goes. Cloze and sound syntax stay as written.
 */
export function fieldText(html: string): string {
	return html
		.replace(/<img\b[^>]*?\bsrc="([^"]*)"[^>]*>/gi, '[image: $1]')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<li\b[^>]*>/gi, '- ')
		.replace(/<\/(?:li|p|div|ul|ol|tr|h[1-6])>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&(?:lt|gt|quot|#0?39|nbsp|amp);/g, (entity) => ENTITIES[entity])
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{2,}/g, '\n')
		.trim()
}

export async function inBatches<T>(ids: number[], size: number, read: (batch: number[]) => Promise<T[]>): Promise<T[]> {
	const rows: T[] = []
	for (let i = 0; i < ids.length; i += size) {
		rows.push(...(await read(ids.slice(i, i + size))))
	}
	return rows
}

function readNotes(ids: number[]): Promise<RawNote[]> {
	return inBatches(ids, NOTES_INFO_BATCH_SIZE, (notes) => AnkiConnect.invoke<RawNote[]>('notesInfo', { notes }))
}

function readCards(ids: number[]): Promise<RawCard[]> {
	return inBatches(ids, CARDS_INFO_BATCH_SIZE, (cards) => AnkiConnect.invoke<RawCard[]>('cardsInfo', { cards }))
}

function cardView(card: RawCard): CardView {
	return {
		cardId: card.cardId,
		ord: card.ord,
		deck: card.deckName,
		state: CARD_STATES[card.type] ?? 'unknown',
		suspended: card.queue === SUSPENDED_QUEUE,
		lapses: card.lapses,
		reps: card.reps,
		// A negative interval is in seconds, which only learning cards use.
		intervalDays: card.interval > 0 ? card.interval : Math.floor(Math.abs(card.interval) / SECONDS_PER_DAY),
		easePercent: Math.round(card.factor / 10)
	}
}

/** notesInfo answers an ID it does not know with an empty object. */
function isKnownNote(note: RawNote): boolean {
	return typeof note?.noteId === 'number'
}

async function noteViews(ids: number[], raw: boolean, sourceOf: SourceLookup): Promise<NoteView[]> {
	const notes = (await readNotes(ids)).filter(isKnownNote)
	const cards = await readCards(notes.flatMap((note) => note.cards))
	const cardsById = new Map(cards.map((card) => [card.cardId, card]))
	return notes.map((note) => {
		const fields: Record<string, string> = {}
		for (const [name, field] of Object.entries(note.fields)) {
			const value = raw ? field.value : fieldText(field.value)
			if (value !== '') {
				fields[name] = value
			}
		}
		const sourceFile = sourceOf(note.noteId)
		return {
			noteId: note.noteId,
			modelName: note.modelName,
			tags: note.tags,
			fields,
			...(sourceFile === undefined ? {} : { sourceFile }),
			cards: note.cards.flatMap((id) => {
				const card = cardsById.get(id)
				return card ? [cardView(card)] : []
			})
		}
	})
}

export async function searchNotes(
	search: NoteSearch,
	sourceOf: SourceLookup
): Promise<{ total: number; offset: number; limit: number; notes: NoteView[] }> {
	const ids = await AnkiConnect.invoke<number[]>('findNotes', { query: search.query })
	const page = ids.slice(search.offset, search.offset + search.limit)
	return {
		total: ids.length,
		offset: search.offset,
		limit: search.limit,
		notes: await noteViews(page, search.raw, sourceOf)
	}
}

export async function getNotes(
	ids: number[],
	raw: boolean,
	sourceOf: SourceLookup
): Promise<{ notes: NoteView[]; missing: number[] }> {
	const notes = await noteViews(ids, raw, sourceOf)
	const found = new Set(notes.map((note) => note.noteId))
	return { notes, missing: ids.filter((id) => !found.has(id)) }
}

function deckQuery(deck: string | undefined): string {
	return deck === undefined ? 'deck:*' : `deck:"${deck.replace(/["\\]/g, '\\$&')}"`
}

async function countCards(query: string): Promise<number> {
	return (await AnkiConnect.invoke<number[]>('findCards', { query })).length
}

export interface StudyOverview {
	deck?: string
	due: number
	suspended: number
	leeches: number
	reviewedToday: number
	/** Most recent first; days without reviews are absent. */
	reviewsByDay: Array<{ date: string; cards: number }>
	decks: Array<{ name: string; new: number; learning: number; review: number; total: number }>
}

interface RawDeckStats {
	name: string
	new_count: number
	learn_count: number
	review_count: number
	total_in_deck: number
}

export async function studyOverview(deck: string | undefined, days: number): Promise<StudyOverview> {
	const scope = deckQuery(deck)
	const names = deck === undefined ? await AnkiConnect.invoke<string[]>('deckNames') : [deck]
	const stats = await AnkiConnect.invoke<Record<string, RawDeckStats>>('getDeckStats', { decks: names })
	const byDay = await AnkiConnect.invoke<Array<[string, number]>>('getNumCardsReviewedByDay')
	return {
		...(deck === undefined ? {} : { deck }),
		due: await countCards(`${scope} is:due`),
		suspended: await countCards(`${scope} is:suspended`),
		leeches: await countCards(`${scope} tag:leech`),
		reviewedToday: await AnkiConnect.invoke<number>('getNumCardsReviewedToday'),
		reviewsByDay: byDay.slice(0, days).map(([date, cards]) => ({ date, cards })),
		decks: Object.values(stats).map((stat) => ({
			name: stat.name,
			new: stat.new_count,
			learning: stat.learn_count,
			review: stat.review_count,
			total: stat.total_in_deck
		}))
	}
}

export interface DifficultCardsQuery {
	deck?: string
	minLapses: number
	limit: number
	includeSuspended: boolean
	raw: boolean
}

export interface DifficultCard extends CardView {
	noteId: number
	modelName: string
	tags: string[]
	fields: Record<string, string>
	sourceFile?: string
	reviews: { total: number; again: number; lastReviewedAt?: string }
}

function reviewSummary(reviews: RawReview[] | undefined): DifficultCard['reviews'] {
	const history = reviews ?? []
	const last = history.reduce((latest, review) => Math.max(latest, review.id), 0)
	return {
		total: history.length,
		again: history.filter((review) => review.ease === ANKI_AGAIN_EASE).length,
		// A review's ID is the moment it happened, in milliseconds.
		...(last > 0 ? { lastReviewedAt: new Date(last).toISOString() } : {})
	}
}

/** The cards you fail most, with their text and where to rewrite them. */
export async function difficultCards(
	query: DifficultCardsQuery,
	sourceOf: SourceLookup
): Promise<{ total: number; cards: DifficultCard[] }> {
	const filters = [deckQuery(query.deck), `prop:lapses>=${query.minLapses}`]
	if (!query.includeSuspended) {
		filters.push('-is:suspended')
	}
	const ids = await AnkiConnect.invoke<number[]>('findCards', { query: filters.join(' ') })
	const ranked = (await readCards(ids)).sort((a, b) => b.lapses - a.lapses).slice(0, query.limit)
	const notes = await noteViews([...new Set(ranked.map((card) => card.note))], query.raw, sourceOf)
	const noteById = new Map(notes.map((note) => [note.noteId, note]))
	const reviews =
		ranked.length === 0
			? {}
			: await AnkiConnect.invoke<Record<string, RawReview[]>>('getReviewsOfCards', {
					cards: ranked.map((card) => card.cardId)
				})
	return {
		total: ids.length,
		cards: ranked.flatMap((card) => {
			const note = noteById.get(card.note)
			if (!note) {
				return []
			}
			return [
				{
					...cardView(card),
					noteId: note.noteId,
					modelName: note.modelName,
					tags: note.tags,
					fields: note.fields,
					...(note.sourceFile === undefined ? {} : { sourceFile: note.sourceFile }),
					reviews: reviewSummary(reviews[String(card.cardId)])
				}
			]
		})
	}
}

export interface VaultRules {
	defaultDeck: string
	curlyCloze: boolean
	highlightsToCloze: boolean
	idComments: boolean
	deleteRemovedNotes: boolean
	allowNoteTypeChanges: boolean
	syncToAnkiWeb: boolean
	schedulingIntervalMinutes: number
	scanDirectories: string[]
	syntax: Record<string, string>
}

export interface CollectionMetadata {
	decks: string[]
	/** `syncable` is false for a type the plugin's table does not know yet. */
	noteTypes: Array<{ name: string; fields: string[]; syncable: boolean }>
	tags: string[]
	rules: VaultRules
}

/** What an agent must know before writing a card for this collection. */
export async function collectionMetadata(
	fieldsDict: Record<string, string[]>,
	rules: VaultRules
): Promise<CollectionMetadata> {
	const names = await AnkiConnect.invoke<string[]>('modelNames')
	const noteTypes = await Promise.all(
		names.map(async (name) => {
			const known = fieldsDict[name]
			return {
				name,
				fields: known ?? (await AnkiConnect.invoke<string[]>('modelFieldNames', { modelName: name })),
				syncable: known !== undefined
			}
		})
	)
	return {
		decks: await AnkiConnect.invoke<string[]>('deckNames'),
		noteTypes,
		tags: await AnkiConnect.invoke<string[]>('getTags'),
		rules
	}
}
