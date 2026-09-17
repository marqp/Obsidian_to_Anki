import * as AnkiConnect from './anki'
import type { AnkiConnectNote, AnkiConnectNoteAndID } from './interfaces/note-interface'

/**
 * Pure AnkiConnect request builders extracted from AbstractFile (Wave 4).
 * Same payloads, no file state: callers pass the slices the builders need,
 * so every wire shape is unit-testable without scanning a vault. The
 * AbstractFile get* methods delegate 1:1 and stay the callers' entry point.
 */

/** Tags an existing note should carry in Anki: note tags plus file-level tags. */
export function noteTagsFor(noteTags: string[], globalTags: string): string[] {
	return joinedNoteTags(noteTags, globalTags)
		.split(' ')
		.filter((tag) => tag.length > 0)
}

/**
 * Raw joined tag string. The legacy updateNoteTags batch splits it WITHOUT
 * filtering empties (so a note with no global tags still sends a trailing
 * ''), while updateNote/updateNoteModel use the filtered noteTagsFor. Both
 * shapes are wire format — keep them distinct.
 */
export function joinedNoteTags(noteTags: string[], globalTags: string): string {
	return noteTags.join(' ') + ' ' + globalTags
}

export function buildCreateDecks(notes: AnkiConnectNote[]): AnkiConnect.AnkiConnectRequest {
	const actions: AnkiConnect.AnkiConnectRequest[] = []
	for (const note of notes) {
		actions.push(AnkiConnect.createDeck(note.deckName))
	}
	return AnkiConnect.multi(actions)
}

export function buildAddNotes(notes: AnkiConnectNote[]): AnkiConnect.AnkiConnectRequest {
	const actions: AnkiConnect.AnkiConnectRequest[] = []
	for (const note of notes) {
		actions.push(AnkiConnect.addNote(note))
	}
	return AnkiConnect.multi(actions)
}

export function buildDeleteNotes(noteIds: number[]): AnkiConnect.AnkiConnectRequest {
	return AnkiConnect.deleteNotes(noteIds)
}

/**
 * Update batch for existing notes. `useUpdateNote` consolidates fields and
 * tags into one action per note (AnkiConnect >= updateNote); false keeps the
 * legacy updateNoteFields-only batch. Notes without an identifier are skipped.
 */
export function buildNoteUpdates(
	edits: AnkiConnectNoteAndID[],
	useUpdateNote: boolean,
	tagsFor: (parsed: AnkiConnectNoteAndID) => string[]
): AnkiConnect.AnkiConnectRequest {
	const actions: AnkiConnect.AnkiConnectRequest[] = []
	for (const parsed of edits) {
		if (parsed.identifier == null) {
			continue
		}
		if (useUpdateNote) {
			actions.push(AnkiConnect.updateNote(parsed.identifier, parsed.note.fields, tagsFor(parsed)))
		} else {
			actions.push(AnkiConnect.updateNoteFields(parsed.identifier, parsed.note.fields))
		}
	}
	return AnkiConnect.multi(actions)
}

export function buildNoteInfo(edits: AnkiConnectNoteAndID[]): AnkiConnect.AnkiConnectRequest {
	const IDs: number[] = []
	for (const parsed of edits) {
		if (parsed.identifier == null) {
			continue
		}
		IDs.push(parsed.identifier)
	}
	return AnkiConnect.notesInfo(IDs)
}

export interface DeckGroupInput {
	deck: string
	card_ids: number[]
}

/**
 * Group card IDs by target deck. Single-deck files (or frontmatter-forced
 * decks) move every card to the file target; otherwise per-note overrides
 * merge by deck, skipping empty groups.
 */
export function groupTargetDecks(
	frontmatterHasDeck: boolean,
	targetDeck: string,
	cardIds: number[],
	noteEditDeckMap: DeckGroupInput[]
): Map<string, number[]> {
	if (frontmatterHasDeck || noteEditDeckMap.length <= 1) {
		return new Map([[targetDeck, [...cardIds]]])
	}
	const byDeck = new Map<string, number[]>()
	for (const group of noteEditDeckMap) {
		if (group.card_ids.length > 0) {
			byDeck.set(group.deck, [...(byDeck.get(group.deck) ?? []), ...group.card_ids])
		}
	}
	return byDeck
}

export function buildChangeDecks(grouped: Map<string, number[]>): AnkiConnect.AnkiConnectRequest {
	const actions: AnkiConnect.AnkiConnectRequest[] = []
	for (const [deck, cardIds] of grouped) {
		if (cardIds.length > 0) {
			actions.push(AnkiConnect.changeDeck(cardIds, deck))
		}
	}
	if (actions.length === 1) {
		return actions[0]
	}
	return AnkiConnect.multi(actions)
}

export function buildUpdateTags(
	edits: AnkiConnectNoteAndID[],
	joinTags: (parsed: AnkiConnectNoteAndID) => string
): AnkiConnect.AnkiConnectRequest {
	const actions: AnkiConnect.AnkiConnectRequest[] = []
	for (const parsed of edits) {
		if (parsed.identifier == null) {
			continue
		}
		actions.push(AnkiConnect.updateNoteTags(parsed.identifier, joinTags(parsed).split(' ')))
	}
	return AnkiConnect.multi(actions)
}
