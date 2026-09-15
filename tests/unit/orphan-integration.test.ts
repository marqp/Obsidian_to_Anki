import { describe, it, expect, vi, afterEach } from 'vitest'
import * as AnkiConnect from '../../src/anki'
import { FileManager } from '../../src/files-manager'
import { createParsedSettings } from './anki-test-helpers'
import type { FileHashes } from '../../src/scan-optimizations'
import type { App, TFile } from 'obsidian'

const NOTE_WITH_ID_1 = 'START\nBasic\nFront: q\nBack: a\n<!--ID: 1-->\nEND'

function fakeApp(content: string) {
	const modify = vi.fn()
	const app = {
		vault: {
			read: async () => content,
			modify,
			getName: () => 'vault',
			adapter: { getFullPath: (p: string) => p }
		},
		metadataCache: { getCache: () => ({}), getFirstLinkpathDest: () => null }
	} as unknown as App
	return { app, modify }
}

function fakeTFile(): TFile {
	return { path: 'note.md', stat: { mtime: 200, size: 100 } } as unknown as TFile
}

function multiResponseForNote1() {
	const noteInfo = { noteId: 1, modelName: 'Basic', tags: [], fields: {}, cards: [9] }
	return [
		{ error: null, result: [] },
		{ error: null, result: [{ error: null, result: [] }] },
		{ error: null, result: [{ error: null, result: [noteInfo] }] },
		{ error: null, result: [] },
		{ error: null, result: [{ error: null, result: [] }] },
		{ error: null, result: [null] },
		{ error: null, result: [] }
	]
}

function storedEntry(noteIds: number[]): FileHashes {
	return { 'note.md': { hash: 'stale-hash', mtime: 100, size: 50, noteIds } }
}

describe('orphan deletion: initialiseFiles wiring', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('detects removed note IDs, persists the survivors and deletes the orphans', async () => {
		const parsed = createParsedSettings({
			delete_removed_notes: true,
			EXISTING_IDS: new Set([1, 2])
		})
		const { app } = fakeApp(NOTE_WITH_ID_1)
		const manager = new FileManager(app, parsed, [fakeTFile()], storedEntry([1, 2]), [])
		await manager.initialiseFiles()

		expect(manager.orphanNoteIds).toEqual([2])
		const hashes = manager.getHashes()
		const entry = hashes['note.md'] as { noteIds?: number[] }
		expect(entry.noteIds).toEqual([1])

		const invokeMock = vi.fn(async (action: string) => {
			if (action === 'apiReflect') {
				return { scopes: ['actions'], actions: [] }
			}
			return multiResponseForNote1()
		})
		AnkiConnect.setTransport({ invoke: invokeMock })
		await manager.requests_1()

		const mainMulti = invokeMock.mock.calls[1][1] as { actions: AnkiConnect.AnkiConnectRequest[] }
		const deleteBatches = mainMulti.actions
			.filter((action) => action.action === 'multi')
			.flatMap((action) => action.params['actions'] as AnkiConnect.AnkiConnectRequest[])
			.filter((action) => action.action === 'deleteNotes')
		const deletedIds = deleteBatches.flatMap((action) => action.params['notes'] as number[])
		expect(deletedIds).toContain(2)
	})

	it('does nothing when the setting is off', async () => {
		const parsed = createParsedSettings({
			delete_removed_notes: false,
			EXISTING_IDS: new Set([1, 2])
		})
		const { app } = fakeApp(NOTE_WITH_ID_1)
		const manager = new FileManager(app, parsed, [fakeTFile()], storedEntry([1, 2]), [])
		await manager.initialiseFiles()

		expect(manager.orphanNoteIds).toEqual([])
	})

	it('ignores legacy string cache entries (no stored record)', async () => {
		const parsed = createParsedSettings({
			delete_removed_notes: true,
			EXISTING_IDS: new Set([1, 2])
		})
		const { app } = fakeApp('no note blocks here')
		const legacyHashes: FileHashes = { 'note.md': 'legacy-hash' }
		const manager = new FileManager(app, parsed, [fakeTFile()], legacyHashes, [])
		await manager.initialiseFiles()

		expect(manager.orphanNoteIds).toEqual([])
	})

	it('keeps IDs referenced by an unscanned file', async () => {
		const parsed = createParsedSettings({
			delete_removed_notes: true,
			EXISTING_IDS: new Set([1, 2])
		})
		const { app } = fakeApp('no note blocks here')
		const hashes = storedEntry([1])
		hashes['other.md'] = { hash: 'x', mtime: 1, size: 1, noteIds: [1] }
		const manager = new FileManager(app, parsed, [fakeTFile()], hashes, [])
		await manager.initialiseFiles()

		expect(manager.orphanNoteIds).toEqual([])
	})

	it('does not double-delete IDs already consumed by a DELETE line', async () => {
		const parsed = createParsedSettings({
			delete_removed_notes: true,
			EXISTING_IDS: new Set([1, 2])
		})
		const content = `${NOTE_WITH_ID_1}\n\nDELETE\nID: 2`
		const { app } = fakeApp(content)
		const manager = new FileManager(app, parsed, [fakeTFile()], storedEntry([1, 2]), [])
		await manager.initialiseFiles()

		expect(manager.orphanNoteIds).toEqual([])
		expect(manager.ownFiles[0].notes_to_delete).toEqual([2])
	})
})
