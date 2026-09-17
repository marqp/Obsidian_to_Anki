import { describe, it, expect, vi, afterEach } from 'vitest'
import * as AnkiConnect from '../../src/anki'
import { FileManager } from '../../src/files-manager'
import { AllFile } from '../../src/file'
import { createFileData } from '../../src/scan-optimizations'
import { createParsedSettings } from './anki-test-helpers'
import type { ParsedSettings } from '../../src/interfaces/settings-interface'
import type { App, CachedMetadata } from 'obsidian'

afterEach(() => {
	vi.restoreAllMocks()
})

function testApp(): App {
	return {
		vault: { getName: () => 'vault', modify: vi.fn(), adapter: { getFullPath: (p: string) => p } },
		metadataCache: { getFirstLinkpathDest: () => null }
	} as unknown as App
}

function testNote() {
	return {
		deckName: 'Default',
		modelName: 'Basic',
		fields: { Front: 'Q', Back: 'A' },
		options: { allowDuplicate: true },
		tags: []
	}
}

/** FileManager with N files; per-file batch entries supplied by the caller. */
function managerWithFiles(
	data: ParsedSettings,
	paths: string[],
	batchByIndex: { addedIds: unknown[]; notesInfo: unknown; tagList: unknown }
) {
	const manager = new FileManager(testApp(), data, [], {}, [])
	for (const path of paths) {
		const file = new AllFile('', path, '', createFileData(data, 'Default', []), {} as CachedMetadata)
		manager.ownFiles.push(file)
	}
	manager.files = []
	const multiResponse = [
		{ error: null, result: [] },
		{ error: null, result: batchByIndex.addedIds },
		batchByIndex.notesInfo,
		batchByIndex.tagList,
		{ error: null, result: [] },
		{ error: null, result: [] },
		{ error: null, result: [] }
	]
	const invokeMock = vi.fn(async (action: string) => {
		if (action === 'apiReflect') {
			return { scopes: ['actions'], actions: [] }
		}
		return multiResponse
	})
	AnkiConnect.setTransport({ invoke: invokeMock })
	return { manager, invokeMock }
}
function managerWithAdd(data: ParsedSettings, addedIdsResult: unknown) {
	const manager = new FileManager(testApp(), data, [], {}, [])
	const file = new AllFile('', 'note.md', '', createFileData(data, 'Default', []), {} as CachedMetadata)
	file.all_notes_to_add = [testNote() as never]
	manager.ownFiles = [file]
	manager.files = []
	const multiResponse = [
		{ error: null, result: [] },
		{ error: null, result: addedIdsResult },
		{ error: null, result: [] },
		{ error: null, result: [] },
		{ error: null, result: [] },
		{ error: null, result: [] },
		{ error: null, result: [] }
	]
	const invokeMock = vi.fn(async (action: string) => {
		if (action === 'apiReflect') {
			return { scopes: ['actions'], actions: [] }
		}
		return multiResponse
	})
	AnkiConnect.setTransport({ invoke: invokeMock })
	return manager
}

describe('parse_requests_1: named batch + ScanIssue collection', () => {
	it('routes added IDs and collects no issues on a clean batch', async () => {
		const data = createParsedSettings()
		const manager = managerWithAdd(data, [{ error: null, result: [{ result: 4242, error: null }] }])
		const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)

		await manager.requests_1()

		expect(manager.ownFiles[0].note_ids).toEqual([4242])
		expect(manager.scanIssues).toEqual([])
		expect(infoSpy.mock.calls.some(([line]) => String(line).includes('scan issues:'))).toBe(false)
	})

	it('collects a structured issue when one add fails, keeping legacy warn + fallback', async () => {
		const data = createParsedSettings()
		const manager = managerWithAdd(data, [
			{ error: null, result: [{ result: null, error: 'cannot create note: duplicate' }] }
		])
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)

		await manager.requests_1()

		// Legacy behavior preserved: warn text untouched, null-ID fallback pushed.
		expect(warnSpy.mock.calls.some((args) => String(args[0]).includes('Failed to add note '))).toBe(true)
		expect(manager.ownFiles[0].note_ids).toEqual([null])
		// New structured collection alongside it.
		expect(manager.scanIssues).toEqual([
			{ file: 'note.md', kind: 'add-note', error: 'AnkiConnect [parse]: cannot create note: duplicate' }
		])
		expect(
			infoSpy.mock.calls.some(([line]) =>
				String(line).includes('[Obsidian_to_Anki] scan issues: [{"file":"note.md"')
			)
		).toBe(true)
	})

	it('isolates a batch notesInfo failure and still completes the scan', async () => {
		const data = createParsedSettings()
		const { manager } = managerWithFiles(data, ['note.md'], {
			addedIds: [{ error: null, result: [] }],
			notesInfo: { error: 'notesInfo failed', result: null },
			tagList: { error: null, result: [] }
		})
		vi.spyOn(console, 'error').mockImplementation(() => undefined)

		await manager.requests_1()

		expect(manager.scanIssues).toEqual([
			{ file: '', kind: 'notes-info', error: 'AnkiConnect [parse]: notesInfo failed' }
		])
		// Deck maps stay empty but ID stamping, tag list and requests_2 ran.
		expect(manager.ownFiles[0].note_edit_deck_map).toEqual([])
		expect(manager.ownFiles[0].tags).toEqual([])
	})

	it('isolates one bad file notesInfo and still processes the other file', async () => {
		const data = createParsedSettings()
		const { manager } = managerWithFiles(data, ['bad.md', 'good.md'], {
			addedIds: [
				{ error: null, result: [] },
				{ error: null, result: [] }
			],
			notesInfo: {
				error: null,
				result: [
					{ error: 'bad file payload', result: null },
					{
						error: null,
						result: [{ noteId: 55, modelName: 'Cloze', tags: [], fields: {}, cards: [777] }]
					}
				]
			},
			tagList: { error: null, result: [] }
		})
		manager.ownFiles[1].notes_to_edit = [
			{
				identifier: 55,
				note: {
					deckName: 'Default',
					modelName: 'Cloze',
					fields: {},
					options: { allowDuplicate: true },
					tags: []
				}
			}
		]
		vi.spyOn(console, 'error').mockImplementation(() => undefined)

		await manager.requests_1()

		expect(manager.scanIssues).toEqual([
			{ file: 'bad.md', kind: 'note-info-file', error: 'AnkiConnect [parse]: bad file payload' }
		])
		expect(manager.ownFiles[0].note_edit_deck_map).toEqual([])
		expect(manager.ownFiles[1].note_edit_deck_map).toEqual([{ card_ids: [777], deck: 'Default' }])
	})

	it('isolates a tagList failure and still completes the scan', async () => {
		const data = createParsedSettings()
		const { manager } = managerWithFiles(data, ['note.md'], {
			addedIds: [{ error: null, result: [] }],
			notesInfo: { error: null, result: [] },
			tagList: { error: 'no tags today', result: null }
		})
		vi.spyOn(console, 'error').mockImplementation(() => undefined)

		await manager.requests_1()

		expect(manager.scanIssues).toEqual([
			{ file: '', kind: 'tag-list', error: 'AnkiConnect [parse]: no tags today' }
		])
		expect(manager.ownFiles[0].tags).toEqual([])
	})
})
