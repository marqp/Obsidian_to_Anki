import * as AnkiConnect from './anki'
import type { AllFile } from './file'
import type { ScanIssue } from './files-manager'
import type { AnkiConnectNote, AnkiConnectNoteAndID } from './interfaces/note-interface'
import { hasClozeCards, isImageOcclusion } from './note'
import { maskDifferences } from './occlusion'
import { ANKI_STATUS_TAGS } from './requests'

/** One pending change discovered by a dry run, machine-readable. */
export interface DryRunChange {
	kind: 'add' | 'update' | 'delete' | 'convert'
	file: string
	noteId?: number
	deck?: string
	modelName?: string
	fromModel?: string
	toModel?: string
	/** Update entries: the fields whose text differs from Anki. */
	fields?: string[]
	/** Update entries: the tags differ from Anki. */
	tagsChanged?: boolean
	/** Update entries: a card is in another deck in Anki. */
	deckChanged?: boolean
	/** Update entries, when asked for: what Anki holds and what the scan would write. */
	diff?: NoteDiff
	/** 1-based line of the block; absent when the block is gone (orphan delete). */
	line?: number
	/** Add entries: the start of the new card, to recognise it. */
	snippet?: string
	/** Delete entries only: an explicit DELETE line, or a block gone from the Markdown. */
	deleteReason?: 'delete-line' | 'orphan'
}

/**
 * The text behind an update. Field values are HTML as Anki stores them, cut to
 * DIFF_VALUE_LENGTH characters; `tags` appears only when the tags differ.
 */
export interface NoteDiff {
	fields: Record<string, { anki: string; markdown: string }>
	tags?: { anki: string[]; markdown: string[] }
}

const DIFF_VALUE_LENGTH = 2000

/** Aggregated dry-run result: one console one-liner + one JSON blob. */
export interface DryRunSummary {
	filesChanged: number
	filesTotal: number
	wouldAdd: number
	wouldUpdate: number
	wouldDelete: number
	wouldConvert: number
	/** Live cards touched per deck (read-only review confidence). */
	decks: DryRunDeckStat[]
	changes: DryRunChange[]
	/** Notes the sync would leave alone and report, because their type differs. */
	issues: ScanIssue[]
	/** Changed media files to send to Anki. */
	resentMedia?: string[]
}

/** Cards the preview would touch in one deck (Anki `type === 0` counts as new). */
export interface DryRunDeckStat {
	deck: string
	cards: number
	new: number
}

export interface AnkiNoteInfo {
	noteId: number
	modelName: string
	tags: string[]
	fields: Record<string, { order: number; value: string }>
	cards: number[]
}

interface AnkiCardInfo {
	cardId: number
	/** AnkiConnect names this `deckName`; there is no `deck` key on the wire. */
	deckName: string
	/** Anki card type: 0 = new (learning/review/relearning are non-zero). */
	type?: number
}

/**
 * Batched read sizes for the live-Anki preflight. One giant notesInfo with
 * thousands of IDs risks daemon-side limits and huge payloads; chunks keep
 * the same semantics with bounded requests (Flashcards 256/512 pattern).
 */
const NOTES_INFO_BATCH_SIZE = 256
const CARDS_INFO_BATCH_SIZE = 512
const DRY_RUN_SNIPPET_LENGTH = 100

async function fetchNotesInfo(editIds: number[]): Promise<AnkiNoteInfo[]> {
	const infos: AnkiNoteInfo[] = []
	for (let i = 0; i < editIds.length; i += NOTES_INFO_BATCH_SIZE) {
		const batch = await AnkiConnect.invoke<AnkiNoteInfo[]>('notesInfo', {
			notes: editIds.slice(i, i + NOTES_INFO_BATCH_SIZE)
		})
		infos.push(...batch)
	}
	return infos
}

async function fetchCardsInfo(cardIds: number[]): Promise<AnkiCardInfo[]> {
	const infos: AnkiCardInfo[] = []
	for (let i = 0; i < cardIds.length; i += CARDS_INFO_BATCH_SIZE) {
		const batch = await AnkiConnect.invoke<AnkiCardInfo[]>('cardsInfo', {
			cards: cardIds.slice(i, i + CARDS_INFO_BATCH_SIZE)
		})
		infos.push(...batch)
	}
	return infos
}

/**
 * Read-only preview of what a real scan would do. Queries Anki state
 * (notesInfo + cardsInfo) but never dispatches mutations and never touches
 * the vault, so it is safe to run for inspection by humans and CLI agents.
 *
 * Orphan deletes come from the caller's already-computed orphan list
 * (FileManager.orphanNoteIds): re-deriving them here would need the same
 * stored-ID snapshot, so the manager hands them over instead. The optional
 * orphanFileById map attributes each orphan to the file that last carried
 * it, so UIs can group deletes per file instead of showing a bare ID list.
 */
export async function collectDryRunState(
	files: AllFile[],
	options: {
		hasNoteTypeChanges: boolean
		orphanNoteIds: number[]
		orphanFileById?: Map<number, string>
		/** Add the before and after text to each update. */
		includeDiff?: boolean
		/** Whole-vault comparison: all files were checked, even unchanged ones. */
		everyFile?: boolean
	}
): Promise<DryRunSummary> {
	const changes: DryRunChange[] = []
	const issues: ScanIssue[] = []
	let wouldAdd = 0
	let wouldUpdate = 0
	let wouldConvert = 0
	const { hasNoteTypeChanges, orphanNoteIds, orphanFileById, includeDiff = false } = options

	const editIds: number[] = []
	for (const file of files) {
		for (const parsed of file.notes_to_edit) {
			if (parsed.identifier != null) {
				editIds.push(parsed.identifier)
			}
		}
	}
	const noteInfos = editIds.length ? await fetchNotesInfo(editIds) : []
	const infoById = new Map<number, AnkiNoteInfo>()
	for (const info of noteInfos) {
		if (info) {
			infoById.set(info.noteId, info)
		}
	}

	const cardIds = noteInfos.flatMap((info) => info?.cards ?? [])
	const uniqueCardIds = [...new Set(cardIds)]
	const cardInfos = uniqueCardIds.length ? await fetchCardsInfo(uniqueCardIds) : []
	const deckByCardId = new Map<number, string>()
	const cardInfoById = new Map<number, AnkiCardInfo>()
	for (const card of cardInfos) {
		if (card) {
			deckByCardId.set(card.cardId, card.deckName)
			cardInfoById.set(card.cardId, card)
		}
	}

	const updatedNoteIds = new Set<number>()
	const explicitDeletes: DryRunChange[] = []

	for (const file of files) {
		const targets = targetDecksFor(file, infoById)
		for (const noteId of file.notes_to_delete) {
			explicitDeletes.push({ kind: 'delete', file: file.path, noteId, deleteReason: 'delete-line' })
		}
		file.all_notes_to_add.forEach((note, index) => {
			wouldAdd += 1
			const line = file.addedNoteLine(index)
			const snippet = noteSnippet(note)
			changes.push({
				kind: 'add',
				file: file.path,
				deck: note.deckName,
				modelName: note.modelName,
				...(line === undefined ? {} : { line }),
				...(snippet === '' ? {} : { snippet })
			})
		})
		for (const parsed of file.notes_to_edit) {
			if (parsed.identifier == null) {
				continue
			}
			const anki = infoById.get(parsed.identifier)
			if (!anki) {
				continue
			}
			if (isModelMismatch(parsed.note, anki)) {
				if (hasNoteTypeChanges) {
					wouldConvert += 1
					changes.push({
						kind: 'convert',
						file: file.path,
						noteId: parsed.identifier,
						fromModel: anki.modelName,
						toModel: parsed.note.modelName
					})
				} else {
					issues.push(noteTypeMismatch(file, parsed.identifier, parsed.note.modelName, anki.modelName))
				}
				continue
			}
			const emptied = clozeCardsEmptied(file, parsed, anki)
			if (emptied) {
				issues.push(emptied)
			}
			const replaced = occlusionMasksReplaced(file, parsed, anki)
			if (replaced) {
				issues.push(replaced)
			}
			const localTags = file.noteTagsFor(parsed)
			const difference = diffNote(parsed.note, localTags, anki)
			const deckChanged = isDeckMismatch(targets, anki, deckByCardId)
			if (difference.fields.length > 0 || difference.tagsChanged || deckChanged) {
				if (!updatedNoteIds.has(parsed.identifier)) {
					updatedNoteIds.add(parsed.identifier)
					wouldUpdate += 1
				}
				const line = file.editedNoteLine(parsed.identifier)
				changes.push({
					kind: 'update',
					file: file.path,
					noteId: parsed.identifier,
					deck: parsed.note.deckName,
					modelName: parsed.note.modelName,
					fields: difference.fields,
					...(difference.tagsChanged ? { tagsChanged: true } : {}),
					...(deckChanged ? { deckChanged: true } : {}),
					...(line === undefined ? {} : { line }),
					...(includeDiff ? { diff: noteDiff(parsed.note, localTags, anki, difference) } : {})
				})
			}
		}
	}

	const allChanges: DryRunChange[] = [
		...changes,
		...explicitDeletes,
		...orphanNoteIds.map((noteId) => ({
			kind: 'delete' as const,
			file: orphanFileById?.get(noteId) ?? '',
			noteId,
			deleteReason: 'orphan' as const
		}))
	]

	let filesChanged = files.length
	if (options.everyFile) {
		const changedFiles = new Set<string>()
		for (const change of allChanges) {
			if (change.file) {
				changedFiles.add(change.file)
			}
		}
		for (const issue of issues) {
			if (issue.file) {
				changedFiles.add(issue.file)
			}
		}
		for (const file of files) {
			if (file.parseIssues?.length && file.path) {
				changedFiles.add(file.path)
			}
		}
		filesChanged = changedFiles.size
	}

	return {
		filesChanged,
		filesTotal: files.length,
		wouldAdd,
		wouldUpdate,
		wouldDelete: explicitDeletes.length + orphanNoteIds.length,
		wouldConvert,
		decks: collectDeckStats(uniqueCardIds, deckByCardId, cardInfoById),
		changes: allChanges,
		issues
	}
}

/** The issue for a note whose type differs while "Allow Note Type Changes" is off. */
export function noteTypeMismatch(file: AllFile, noteId: number, localModel: string, ankiModel: string): ScanIssue {
	const line = file.editedNoteLine(noteId)
	return {
		file: file.path,
		kind: 'note-type-mismatch',
		noteId,
		...(line === undefined ? {} : { line }),
		error: `Note is "${localModel}" in Markdown but "${ankiModel}" in Anki. Enable "Allow Note Type Changes" to convert it.`
	}
}

function clozeNumbers(text: string): number[] {
	return Array.from(text.matchAll(/{{c(\d+(?:,\d+)*)::/g), (match) => match[1].split(',').map(Number)).flat()
}

/**
 * The issue for a note that would lose a cloze number. Anki does not delete that
 * card: it stays empty, with its review history, until "Empty Cards" removes it.
 * Fields the block leaves out keep their text in Anki, so their numbers survive.
 */
export function clozeCardsEmptied(
	file: AllFile,
	parsed: AnkiConnectNoteAndID,
	anki: AnkiNoteInfo
): ScanIssue | undefined {
	if (parsed.identifier == null || !hasClozeCards(anki.modelName) || parsed.note.modelName !== anki.modelName) {
		return undefined
	}
	const kept = new Set<number>()
	const before = new Set<number>()
	for (const [name, field] of Object.entries(anki.fields)) {
		const numbers = clozeNumbers(field.value)
		numbers.forEach((number) => before.add(number))
		if (!(name in parsed.note.fields)) {
			numbers.forEach((number) => kept.add(number))
		}
	}
	for (const value of Object.values(parsed.note.fields)) {
		clozeNumbers(value).forEach((number) => kept.add(number))
	}
	const gone = [...before].filter((number) => !kept.has(number)).sort((a, b) => a - b)
	if (gone.length === 0) {
		return undefined
	}
	const line = file.editedNoteLine(parsed.identifier)
	return {
		file: file.path,
		kind: 'cloze-card-emptied',
		noteId: parsed.identifier,
		...(line === undefined ? {} : { line }),
		error: `${gone.map((number) => `c${number}`).join(', ')} no longer in the Markdown. Anki keeps each of those cards empty, with its review history, until "Empty Cards" removes it. Put the number back to keep the card.`
	}
}

/**
 * The issue for a sync that drops masks present in Anki. They may be an adjustment
 * made in its editor, so the issue keeps them: nothing else would.
 */
export function occlusionMasksReplaced(
	file: AllFile,
	parsed: AnkiConnectNoteAndID,
	anki: AnkiNoteInfo
): ScanIssue | undefined {
	const markdown = parsed.note.fields['Occlusion']
	if (parsed.identifier == null || !isImageOcclusion(anki.modelName) || markdown === undefined) {
		return undefined
	}
	const dropped = maskDifferences(anki.fields['Occlusion']?.value ?? '', markdown).onlyInFirst
	if (dropped.length === 0) {
		return undefined
	}
	const line = file.editedNoteLine(parsed.identifier)
	return {
		file: file.path,
		kind: 'occlusion-masks-replaced',
		noteId: parsed.identifier,
		...(line === undefined ? {} : { line }),
		error: `The Markdown replaces these masks in Anki: ${dropped.join(' ')}. If they were adjusted in Anki and the file should keep them, pull them into the Markdown (anki_occlusion_pull) before the scan.`
	}
}

function isModelMismatch(local: AnkiConnectNote, anki: AnkiNoteInfo): boolean {
	return Boolean(local.modelName && anki.modelName && local.modelName !== anki.modelName)
}

function normalizeText(value: string): string {
	// Anki normalizes to NFC server-side; macOS checkouts often yield NFD.
	// Comparing without normalizing reports phantom updates for identical
	// text (Yanki areFieldsEqual/areTagsEqual pattern, scoped to equality —
	// the real scan still writes submitted strings verbatim).
	return value.normalize('NFC')
}

/** Anki treats tags that differ only in case as one tag and keeps a single spelling of it. */
function normalizeTags(tags: string[]): string[] {
	return [...new Set(tags.filter((tag) => tag.length > 0).map((tag) => normalizeText(tag).toLowerCase()))].sort()
}

/**
 * What a real scan would change in this note. `localTags` are the tags the
 * scan would leave on it (note tags plus the file's FILE TAGS), not the bare
 * `local.tags`: comparing those flagged every note of a file with FILE TAGS.
 */
function diffNote(
	local: AnkiConnectNote,
	localTags: string[],
	anki: AnkiNoteInfo
): { fields: string[]; tagsChanged: boolean } {
	const fields = Object.keys(local.fields).filter(
		(field) => normalizeText(anki.fields[field]?.value ?? '') !== normalizeText(local.fields[field])
	)
	// The real scan converges to the same end state on both paths (legacy
	// updateNoteTags vs consolidated updateNote), so one normalized
	// order-insensitive tag comparison covers both.
	const ankiTags = normalizeTags(anki.tags ?? [])
	const wantedTags = normalizeTags([...localTags, ...ankiTags.filter((tag) => ANKI_STATUS_TAGS.includes(tag))])
	const tagsChanged =
		wantedTags.length !== ankiTags.length || wantedTags.some((tag, index) => tag !== ankiTags[index])
	return { fields, tagsChanged }
}

function clip(value: string): string {
	return value.length > DIFF_VALUE_LENGTH ? value.slice(0, DIFF_VALUE_LENGTH) + '…' : value
}

/** The text of the fields and tags that diffNote found different. */
function noteDiff(
	local: AnkiConnectNote,
	localTags: string[],
	anki: AnkiNoteInfo,
	difference: { fields: string[]; tagsChanged: boolean }
): NoteDiff {
	const fields: NoteDiff['fields'] = {}
	for (const field of difference.fields) {
		fields[field] = { anki: clip(anki.fields[field]?.value ?? ''), markdown: clip(local.fields[field]) }
	}
	if (!difference.tagsChanged) {
		return { fields }
	}
	const ankiTags = anki.tags ?? []
	// A scan keeps the status tags Anki sets during study, so they stay on the Markdown side.
	const kept = ankiTags.filter((tag) => ANKI_STATUS_TAGS.includes(normalizeText(tag).toLowerCase()))
	return { fields, tags: { anki: ankiTags, markdown: [...localTags, ...kept] } }
}

export function isContentMismatch(local: AnkiConnectNote, localTags: string[], anki: AnkiNoteInfo): boolean {
	const { fields, tagsChanged } = diffNote(local, localTags, anki)
	return fields.length > 0 || tagsChanged
}

/** The first text in a new card, without markup. */
function noteSnippet(note: AnkiConnectNote): string {
	const first = Object.values(note.fields).find((value) => value !== '') ?? ''
	return first
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, DRY_RUN_SNIPPET_LENGTH)
}

/**
 * Per-deck review confidence from the already-fetched cardsInfo: how many
 * live cards the preview touches per deck, and how many are new. Pure
 * display data — never computed locally, never written.
 */
function collectDeckStats(
	cardIds: number[],
	deckByCardId: Map<number, string>,
	cardInfoById: Map<number, AnkiCardInfo>
): DryRunDeckStat[] {
	const byDeck = new Map<string, DryRunDeckStat>()
	for (const cardId of cardIds) {
		const deck = deckByCardId.get(cardId)
		if (deck === undefined) {
			continue
		}
		const stat = byDeck.get(deck) ?? { deck, cards: 0, new: 0 }
		stat.cards += 1
		if (cardInfoById.get(cardId)?.type === 0) {
			stat.new += 1
		}
		byDeck.set(deck, stat)
	}
	return [...byDeck.values()].sort((a, b) => (a.deck < b.deck ? -1 : a.deck > b.deck ? 1 : 0))
}

/**
 * Where the real scan would move each card. The file's own deck map is only
 * filled while a real scan parses its batch, so the preview supplies the same
 * inputs from its notesInfo read, leaving the file untouched for a later commit.
 */
function targetDecksFor(file: AllFile, infoById: Map<number, AnkiNoteInfo>): Map<number, string> {
	const cardIds: number[] = []
	const noteDecks: Array<{ card_ids: number[]; deck: string }> = []
	for (const parsed of file.notes_to_edit) {
		const cards = parsed.identifier == null ? undefined : infoById.get(parsed.identifier)?.cards
		if (cards) {
			cardIds.push(...cards)
			noteDecks.push({ card_ids: cards, deck: parsed.note.deckName })
		}
	}
	return file.getTargetDeckByCard(cardIds, noteDecks)
}

function isDeckMismatch(targets: Map<number, string>, anki: AnkiNoteInfo, deckByCardId: Map<number, string>): boolean {
	for (const cardId of anki.cards ?? []) {
		const currentDeck = deckByCardId.get(cardId)
		const targetDeck = targets.get(cardId)
		if (currentDeck === undefined || targetDeck === undefined) {
			continue
		}
		if (currentDeck !== targetDeck) {
			return true
		}
	}
	return false
}

export function formatDryRunSummary(summary: DryRunSummary): string {
	return (
		`[Obsidian_to_Anki] dry-run complete: ` +
		`files_changed=${summary.filesChanged}/${summary.filesTotal} ` +
		`would_add=${summary.wouldAdd} would_update=${summary.wouldUpdate} ` +
		`would_delete=${summary.wouldDelete} would_convert=${summary.wouldConvert}`
	)
}
