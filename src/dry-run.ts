import * as AnkiConnect from './anki'
import type { AllFile } from './file'
import type { AnkiConnectNote } from './interfaces/note-interface'

/** One pending change discovered by a dry run, machine-readable. */
export interface DryRunChange {
	kind: 'add' | 'update' | 'delete' | 'convert'
	file: string
	noteId?: number
	deck?: string
	modelName?: string
	fromModel?: string
	toModel?: string
	fields?: string[]
}

/** Aggregated dry-run result: one console one-liner + one JSON blob. */
export interface DryRunSummary {
	filesChanged: number
	filesTotal: number
	wouldAdd: number
	wouldUpdate: number
	wouldDelete: number
	wouldConvert: number
	changes: DryRunChange[]
}

interface AnkiNoteInfo {
	noteId: number
	modelName: string
	tags: string[]
	fields: Record<string, { order: number; value: string }>
	cards: number[]
}

interface AnkiCardInfo {
	cardId: number
	deck: string
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
	options: { hasNoteTypeChanges: boolean; orphanNoteIds: number[]; orphanFileById?: Map<number, string> }
): Promise<DryRunSummary> {
	const changes: DryRunChange[] = []
	let wouldAdd = 0
	let wouldUpdate = 0
	let wouldConvert = 0
	const { hasNoteTypeChanges, orphanNoteIds, orphanFileById } = options

	const editIds: number[] = []
	for (const file of files) {
		for (const parsed of file.notes_to_edit) {
			if (parsed.identifier != null) {
				editIds.push(parsed.identifier)
			}
		}
	}
	const noteInfos = editIds.length ? await AnkiConnect.invoke<AnkiNoteInfo[]>('notesInfo', { notes: editIds }) : []
	const infoById = new Map<number, AnkiNoteInfo>()
	for (const info of noteInfos) {
		if (info) {
			infoById.set(info.noteId, info)
		}
	}

	const cardIds = noteInfos.flatMap((info) => info?.cards ?? [])
	const uniqueCardIds = [...new Set(cardIds)]
	const cardInfos = uniqueCardIds.length
		? await AnkiConnect.invoke<AnkiCardInfo[]>('cardsInfo', { cards: uniqueCardIds })
		: []
	const deckByCardId = new Map<number, string>()
	for (const card of cardInfos) {
		if (card) {
			deckByCardId.set(card.cardId, card.deck)
		}
	}

	const updatedNoteIds = new Set<number>()

	for (const file of files) {
		for (const note of file.all_notes_to_add) {
			wouldAdd += 1
			changes.push({
				kind: 'add',
				file: file.path,
				deck: note.deckName,
				modelName: note.modelName
			})
		}
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
				}
				continue
			}
			if (isContentMismatch(parsed.note, anki) || isDeckMismatch(file, anki, deckByCardId)) {
				if (!updatedNoteIds.has(parsed.identifier)) {
					updatedNoteIds.add(parsed.identifier)
					wouldUpdate += 1
				}
				changes.push({
					kind: 'update',
					file: file.path,
					noteId: parsed.identifier,
					deck: parsed.note.deckName,
					modelName: parsed.note.modelName,
					fields: Object.keys(parsed.note.fields)
				})
			}
		}
	}

	return {
		filesChanged: files.length,
		filesTotal: files.length,
		wouldAdd,
		wouldUpdate,
		wouldDelete: orphanNoteIds.length,
		wouldConvert,
		changes: [
			...changes,
			...orphanNoteIds.map((noteId) => ({
				kind: 'delete' as const,
				file: orphanFileById?.get(noteId) ?? '',
				noteId
			}))
		]
	}
}

function isModelMismatch(local: AnkiConnectNote, anki: AnkiNoteInfo): boolean {
	return Boolean(local.modelName && anki.modelName && local.modelName !== anki.modelName)
}

function normalizeTags(tags: string[]): string[] {
	return [...new Set(tags.filter((tag) => tag.length > 0))].sort()
}

function isContentMismatch(local: AnkiConnectNote, anki: AnkiNoteInfo): boolean {
	for (const field of Object.keys(local.fields)) {
		if ((anki.fields[field]?.value ?? '') !== local.fields[field]) {
			return true
		}
	}
	// The real scan converges to the same end state on both paths (legacy
	// updateNoteTags vs consolidated updateNote), so one normalized
	// order-insensitive tag comparison covers both.
	const localTags = normalizeTags(local.tags)
	const ankiTags = normalizeTags(anki.tags ?? [])
	return localTags.length !== ankiTags.length || localTags.some((tag, index) => tag !== ankiTags[index])
}

function isDeckMismatch(file: AllFile, anki: AnkiNoteInfo, deckByCardId: Map<number, string>): boolean {
	const targets = file.getTargetDeckByCard()
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
