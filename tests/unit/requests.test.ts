import { describe, it, expect } from 'vitest'
import {
	buildAddNotes,
	buildChangeDecks,
	buildCreateDecks,
	buildDeleteNotes,
	buildNoteInfo,
	buildNoteUpdates,
	buildUpdateTags,
	groupTargetDecks,
	joinedNoteTags,
	noteTagsFor
} from '../../src/requests'
import type { AnkiConnectNote, AnkiConnectNoteAndID } from '../../src/interfaces/note-interface'
import { createParsedSettings, createTestFile } from './anki-test-helpers'

function note(overrides: Partial<AnkiConnectNote> = {}): AnkiConnectNote {
	return {
		deckName: 'Default',
		modelName: 'Basic',
		fields: { Front: 'Q', Back: 'A' },
		options: { allowDuplicate: true },
		tags: [],
		...overrides
	}
}

function parsed(id: number | null, tags: string[] = []): AnkiConnectNoteAndID {
	return { identifier: id, note: note({ tags }) }
}

describe('noteTagsFor / joinedNoteTags', () => {
	it('filters empties for the consolidated update path', () => {
		expect(noteTagsFor(['a', 'b'], '')).toEqual(['a', 'b'])
		expect(noteTagsFor([], '')).toEqual([])
		expect(noteTagsFor(['a'], 'file tag')).toEqual(['a', 'file', 'tag'])
	})

	it('keeps the raw join (with trailing empty) for the legacy tags batch', () => {
		expect(joinedNoteTags(['t'], '')).toBe('t ')
		expect(joinedNoteTags([], '')).toBe(' ')
	})
})

describe('buildCreateDecks / buildAddNotes / buildDeleteNotes', () => {
	it('wraps one action per note in order', () => {
		expect(buildCreateDecks([note({ deckName: 'D1' }), note({ deckName: 'D2' })])).toEqual({
			action: 'multi',
			version: 6,
			params: {
				actions: [
					{ action: 'createDeck', version: 6, params: { deck: 'D1' } },
					{ action: 'createDeck', version: 6, params: { deck: 'D2' } }
				]
			}
		})
	})

	it('passes notes through to addNote untouched', () => {
		const notes = [note({ deckName: 'D' })]
		const built = buildAddNotes(notes)
		expect(built.action).toBe('multi')
		const actions = (built.params as { actions: Array<{ action: string; params: { note: unknown } }> }).actions
		expect(actions).toHaveLength(1)
		expect(actions[0].action).toBe('addNote')
		expect(actions[0].params.note).toBe(notes[0])
	})

	it('deletes by ID list', () => {
		expect(buildDeleteNotes([1, 2])).toEqual({
			action: 'deleteNotes',
			version: 6,
			params: { notes: [1, 2] }
		})
	})
})

describe('buildNoteUpdates', () => {
	it('consolidates fields+tags with updateNote when supported', () => {
		const edits = [parsed(5, ['t'])]
		expect(buildNoteUpdates(edits, true, (p) => noteTagsFor(p.note.tags, 'g'))).toEqual({
			action: 'multi',
			version: 6,
			params: {
				actions: [
					{
						action: 'updateNote',
						version: 6,
						params: { note: { id: 5, fields: { Front: 'Q', Back: 'A' }, tags: ['t', 'g'] } }
					}
				]
			}
		})
	})

	it('falls back to updateNoteFields and skips ID-less notes', () => {
		const edits = [parsed(null), parsed(7)]
		const built = buildNoteUpdates(edits, false, (p) => noteTagsFor(p.note.tags, ''))
		const actions = (built.params as { actions: Array<{ action: string }> }).actions
		expect(actions).toHaveLength(1)
		expect(actions[0].action).toBe('updateNoteFields')
	})
})

describe('buildNoteInfo', () => {
	it('collects identifiers, skipping nulls', () => {
		expect(buildNoteInfo([parsed(null), parsed(3), parsed(4)])).toEqual({
			action: 'notesInfo',
			version: 6,
			params: { notes: [3, 4] }
		})
	})
})

describe('groupTargetDecks / buildChangeDecks', () => {
	it('moves every card to the file target for single-deck files', () => {
		// The lone override deck differs from the file target on purpose:
		// the `<= 1` fast path must win over the grouped merge.
		expect(groupTargetDecks(false, 'Default', [1, 2], [{ deck: 'Other', card_ids: [1, 2] }])).toEqual(
			new Map([['Default', [1, 2]]])
		)
	})

	it('frontmatter forces the file target even with overrides', () => {
		expect(groupTargetDecks(true, 'FM', [1], [{ deck: 'Other', card_ids: [1] }])).toEqual(new Map([['FM', [1]]]))
	})

	it('treats an empty deck map as single-deck (no overrides to merge)', () => {
		expect(groupTargetDecks(false, 'Default', [1, 2], [])).toEqual(new Map([['Default', [1, 2]]]))
	})

	it('merges per-note overrides by deck and skips empty groups', () => {
		const grouped = groupTargetDecks(
			false,
			'Default',
			[1, 2, 3],
			[
				{ deck: 'A', card_ids: [1] },
				{ deck: 'B', card_ids: [] },
				{ deck: 'A', card_ids: [2, 3] }
			]
		)
		expect(grouped).toEqual(new Map([['A', [1, 2, 3]]]))
	})

	it('unwraps a single deck move, wraps several', () => {
		expect(buildChangeDecks(new Map([['D', [9]]]))).toEqual({
			action: 'changeDeck',
			version: 6,
			params: { cards: [9], deck: 'D' }
		})
		const multi = buildChangeDecks(
			new Map([
				['A', [1]],
				['B', [2]]
			])
		)
		expect(multi.action).toBe('multi')
		expect((multi.params as { actions: unknown[] }).actions).toHaveLength(2)
	})

	it('skips empty card lists', () => {
		expect(buildChangeDecks(new Map([['D', []]]))).toEqual({ action: 'multi', version: 6, params: { actions: [] } })
	})
})

describe('buildUpdateTags', () => {
	it('preserves the legacy unfiltered split (trailing empty tag)', () => {
		// Wire format: ['t', ''] — the filter from noteTagsFor must NOT apply here.
		expect(buildUpdateTags([parsed(5, ['t'])], (p) => joinedNoteTags(p.note.tags, ''))).toEqual({
			action: 'multi',
			version: 6,
			params: {
				actions: [{ action: 'updateNoteTags', version: 6, params: { note: 5, tags: ['t', ''] } }]
			}
		})
	})

	it('skips ID-less notes', () => {
		const built = buildUpdateTags([parsed(null)], (p) => joinedNoteTags(p.note.tags, ''))
		expect((built.params as { actions: unknown[] }).actions).toHaveLength(0)
	})
})

describe('AbstractFile delegation (1:1 with the pure builders)', () => {
	it('delegates every batch builder without reshaping payloads', () => {
		const data = createParsedSettings()
		const file = createTestFile(data)
		// createTestFile: one edit (id 55, tags ['noteTag']), global_tags 'fileTag'.
		expect(file.getNoteUpdates(true)).toEqual(
			buildNoteUpdates(file.notes_to_edit, true, (p) => file.noteTagsFor(p))
		)
		expect(file.getNoteUpdates(false)).toEqual(
			buildNoteUpdates(file.notes_to_edit, false, (p) => file.noteTagsFor(p))
		)
		expect(file.getNoteInfo()).toEqual(buildNoteInfo(file.notes_to_edit))
		expect(file.getUpdateTags()).toEqual(
			buildUpdateTags(file.notes_to_edit, (p) => joinedNoteTags(p.note.tags, file.global_tags))
		)
		expect(file.noteTagsFor(file.notes_to_edit[0])).toEqual(['noteTag', 'fileTag'])
	})
})
