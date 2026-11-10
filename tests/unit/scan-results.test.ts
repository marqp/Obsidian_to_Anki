import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import type { App } from 'obsidian'
import * as AnkiConnect from '../../src/anki'
import { FileManager } from '../../src/files-manager'
import { createParsedSettings } from './anki-test-helpers'
import { createManagerFiles, type DryRunNoteSpec } from './dry-run-helpers'
import type { ParsedSettings } from '../../src/interfaces/settings-interface'

const ok = { result: null, error: null }

function ankiNote(id: number, front: string, modelName = 'Basic') {
	return {
		noteId: id,
		modelName,
		tags: [],
		fields: { Front: { order: 0, value: front } },
		cards: [id * 10]
	}
}

interface Daemon {
	notesInfo?: unknown
	updates?: unknown
	deletes?: unknown
	followUps?: unknown
	addedIds?: unknown
	sync?: () => unknown
}

/** A FileManager over one file, against a daemon scripted for this scan. */
function setup(edits: DryRunNoteSpec[], daemon: Daemon, data: ParsedSettings = createParsedSettings()) {
	const manager = new FileManager({ vault: { getName: () => 'vault' } } as unknown as App, data, [], {}, [], {
		vault: {
			read: async () => '',
			process: vi.fn(async (_file, fn: (text: string) => string) => fn('')),
			getCache: () => ({}),
			getFirstLinkpathDest: () => null,
			getFullPath: (path: string) => path
		}
	})
	const [file] = createManagerFiles(data, edits, [])
	manager.ownFiles = [file]
	manager.files = []
	let multiCalls = 0
	AnkiConnect.setTransport({
		invoke: vi.fn(async (action: string) => {
			if (action === 'apiReflect') {
				return { scopes: ['actions'], actions: ['updateNote', 'updateNoteModel'] }
			}
			if (action === 'sync') {
				return daemon.sync?.()
			}
			if (action === 'findNotes') {
				return []
			}
			multiCalls += 1
			if (multiCalls > 1) {
				return daemon.followUps ?? [{ result: [], error: null }]
			}
			return [
				{ result: [], error: null },
				daemon.addedIds ?? { result: [{ result: [], error: null }], error: null },
				{ result: [{ result: daemon.notesInfo ?? [], error: null }], error: null },
				daemon.updates ?? { result: [{ result: [], error: null }], error: null },
				daemon.deletes ?? { result: [ok], error: null },
				{ result: [], error: null }
			]
		})
	})
	return { manager, file }
}

beforeEach(() => {
	vi.spyOn(console, 'info').mockImplementation(() => undefined)
	vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
	vi.restoreAllMocks()
})

const twoNotes: DryRunNoteSpec[] = [
	{ id: 1, fields: { Front: 'same' }, tags: [] },
	{ id: 2, fields: { Front: 'new text' }, tags: [] }
]

describe('requests_1: what really happened', () => {
	it('counts only the notes whose content differed from Anki', async () => {
		const { manager } = setup(twoNotes, {
			notesInfo: [ankiNote(1, 'same'), ankiNote(2, 'old text')],
			updates: { result: [{ result: [ok, ok], error: null }], error: null }
		})

		await manager.requests_1()

		expect(manager.updatedNoteCount()).toBe(1)
		expect(manager.scanIssues).toEqual([])
	})

	it('reports a refused update against its note, leaves it out of the count and retries the file', async () => {
		const { manager } = setup(twoNotes, {
			notesInfo: [ankiNote(1, 'old'), ankiNote(2, 'old')],
			updates: {
				result: [{ result: [ok, { result: null, error: 'collection is busy' }], error: null }],
				error: null
			}
		})

		await manager.requests_1()

		expect(manager.scanIssues).toEqual([
			{ file: 'dry-run.md', kind: 'update-note', noteId: 2, error: 'collection is busy' }
		])
		expect(manager.updatedNoteCount()).toBe(1)
		expect(manager.getHashes()).toEqual({})
	})

	it('counts every sent note when the read that compares them failed', async () => {
		const { manager } = setup(twoNotes, {})
		AnkiConnect.setTransport({
			invoke: vi.fn(async (action: string) => {
				if (action === 'apiReflect') {
					return { scopes: ['actions'], actions: ['updateNote'] }
				}
				return [
					{ result: [], error: null },
					{ result: [{ result: [], error: null }], error: null },
					{ result: null, error: 'notesInfo failed' },
					{ result: [], error: null },
					{ result: [{ result: [ok, ok], error: null }], error: null },
					{ result: [ok], error: null },
					{ result: [], error: null }
				]
			})
		})
		vi.spyOn(console, 'error').mockImplementation(() => undefined)

		await manager.requests_1()

		expect(manager.updatedNoteCount()).toBe(2)
	})

	it('keeps a DELETE line whose delete failed, so the next scan can try again', async () => {
		const data = createParsedSettings()
		const { manager, file } = setup(
			[],
			{ deletes: { result: [{ result: null, error: 'locked' }], error: null } },
			data
		)
		file.file = 'DELETE\n<!--ID: 77-->\n'
		file.notes_to_delete = [77]

		await manager.requests_1()

		expect(manager.scanIssues).toEqual([{ file: 'dry-run.md', kind: 'delete-note', error: 'locked' }])
		expect(manager.failedDeleteCount).toBe(1)
		expect(file.file).toContain('DELETE')
		expect(manager.getHashes()).toEqual({})
	})

	it('removes a DELETE line once the delete worked', async () => {
		const { manager, file } = setup([], {})
		file.file = 'DELETE\n<!--ID: 77-->\n'
		file.notes_to_delete = [77]

		await manager.requests_1()

		expect(file.file).not.toContain('DELETE')
		expect(manager.failedDeleteCount).toBe(0)
	})

	it('attributes a failed orphan delete to no file and counts the whole batch', async () => {
		const { manager } = setup([], {
			deletes: { result: [ok, { result: null, error: 'locked' }], error: null }
		})
		manager.orphanNoteIds = [8, 9]

		await manager.requests_1()

		expect(manager.scanIssues).toEqual([{ file: '', kind: 'delete-note', error: 'locked' }])
		expect(manager.failedDeleteCount).toBe(2)
	})

	it('treats a delete batch that failed as a whole as failed for every file', async () => {
		const { manager, file } = setup([], { deletes: { result: null, error: 'offline' } })
		file.notes_to_delete = [77]
		manager.orphanNoteIds = [8]

		await manager.requests_1()

		expect(manager.failedDeleteCount).toBe(2)
		expect(manager.getHashes()).toEqual({})
	})
})

describe('requests_2: follow-up batches are no longer fire-and-forget', () => {
	const single: DryRunNoteSpec[] = [{ id: 1, fields: { Front: 'q' }, tags: [] }]

	it('reports a failed deck move and retries the file', async () => {
		const { manager } = setup(single, {
			notesInfo: [ankiNote(1, 'q')],
			updates: { result: [{ result: [ok], error: null }], error: null },
			followUps: [{ result: [{ result: null, error: 'deck locked' }], error: null }]
		})

		await manager.requests_1()

		expect(manager.scanIssues).toEqual([{ file: 'dry-run.md', kind: 'change-deck', error: 'deck locked' }])
		expect(manager.getHashes()).toEqual({})
	})

	it('counts a real conversion', async () => {
		const data = createParsedSettings({ allow_note_type_changes: true })
		const { manager } = setup(
			[{ id: 1, fields: { Text: 'q' }, tags: [], model: 'Cloze' }],
			{
				notesInfo: [ankiNote(1, 'q', 'Basic')],
				updates: { result: [{ result: [ok], error: null }], error: null },
				followUps: [
					{ result: [ok], error: null },
					{ result: [ok], error: null }
				]
			},
			data
		)

		await manager.requests_1()

		expect(manager.convertedCount).toBe(1)
		expect(manager.scanIssues).toEqual([])
	})

	it('reports a refused conversion against its note', async () => {
		const data = createParsedSettings({ allow_note_type_changes: true })
		const { manager } = setup(
			[{ id: 1, fields: { Text: 'q' }, tags: [], model: 'Cloze' }],
			{
				notesInfo: [ankiNote(1, 'q', 'Basic')],
				updates: { result: [{ result: [ok], error: null }], error: null },
				followUps: [
					{ result: [ok], error: null },
					{ result: [{ result: null, error: 'fields do not match' }], error: null }
				]
			},
			data
		)

		await manager.requests_1()

		expect(manager.convertedCount).toBe(0)
		expect(manager.scanIssues).toEqual([
			{ file: 'dry-run.md', kind: 'convert-note', noteId: 1, error: 'fields do not match' }
		])
		expect(manager.getHashes()).toEqual({})
	})

	it('reports a cloze number that left the note, without retrying forever', async () => {
		const { manager } = setup([{ id: 1, fields: { Text: '{{c1::a}}' }, tags: [], model: 'Cloze' }], {
			notesInfo: [
				{
					noteId: 1,
					modelName: 'Cloze',
					tags: [],
					fields: { Text: { order: 0, value: '{{c1::a}} {{c2::b}}' } },
					cards: [10, 11]
				}
			],
			updates: { result: [{ result: [ok], error: null }], error: null }
		})

		await manager.requests_1()

		expect(manager.scanIssues).toEqual([
			expect.objectContaining({
				kind: 'cloze-card-emptied',
				noteId: 1,
				file: 'dry-run.md',
				error: expect.stringContaining('c2 no longer in the Markdown')
			})
		])
		expect(Object.keys(manager.getHashes())).toEqual(['dry-run.md'])
	})

	it('reports a type mismatch when conversion is off, without retrying forever', async () => {
		const { manager } = setup([{ id: 1, fields: { Text: 'q' }, tags: [], model: 'Cloze' }], {
			notesInfo: [ankiNote(1, 'q', 'Basic')],
			updates: { result: [{ result: [ok], error: null }], error: null }
		})

		await manager.requests_1()

		expect(manager.scanIssues).toEqual([
			expect.objectContaining({ kind: 'note-type-mismatch', noteId: 1, file: 'dry-run.md' })
		])
		expect(Object.keys(manager.getHashes())).toEqual(['dry-run.md'])
	})

	it('reports a failed AnkiWeb sync without retrying the file', async () => {
		const data = createParsedSettings({ sync_to_ankiweb: true })
		const { manager } = setup(
			[],
			{
				sync: () => {
					throw new Error('no network')
				}
			},
			data
		)

		await manager.requests_1()

		expect(manager.scanIssues).toEqual([
			expect.objectContaining({ file: '', kind: 'ankiweb-sync', error: expect.stringContaining('no network') })
		])
		expect(Object.keys(manager.getHashes())).toEqual(['dry-run.md'])
	})
})

describe('getHashes: only clean files are marked as synced', () => {
	it('keeps a file with a note Anki refused to add out of the commit', async () => {
		const { manager } = setup([], {
			addedIds: {
				result: [{ result: [{ result: null, error: 'cannot create note' }], error: null }],
				error: null
			}
		})
		manager.ownFiles[0].all_notes_to_add = [
			{ deckName: 'Default', modelName: 'Basic', fields: {}, options: { allowDuplicate: true }, tags: [] }
		]

		await manager.requests_1()

		expect(manager.getHashes()).toEqual({})
	})

	it('commits a file whose only problem is a note the user must fix', async () => {
		const { manager, file } = setup([], {})
		file.parseIssues = [{ file: file.path, kind: 'cloze-without-deletions', error: 'no deletions', line: 3 }]

		await manager.requests_1()

		expect(Object.keys(manager.getHashes())).toEqual(['dry-run.md'])
		expect(manager.scanIssues).toHaveLength(1)
	})

	it('retries every file when a whole batch failed', async () => {
		const { manager } = setup([], {})
		manager.scanIssues = [{ file: '', kind: 'add-notes', error: 'offline' }]

		expect(manager.getHashes()).toEqual({})
	})

	it('keeps a file edited during sync (file-changed) out of the commit', async () => {
		const { manager, file } = setup([], {})
		manager.scanIssues = [{ file: file.path, kind: 'file-changed', error: 'file changed on disk' }]

		expect(manager.getHashes()).toEqual({})
	})
})
