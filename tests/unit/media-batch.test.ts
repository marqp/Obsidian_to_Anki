import { describe, it, expect, vi, afterEach } from 'vitest'
import { TFile, type App } from 'obsidian'
import * as AnkiConnect from '../../src/anki'
import { FileManager } from '../../src/files-manager'
import { createParsedSettings } from './anki-test-helpers'
import type { AllFile } from '../../src/file'

afterEach(() => {
	vi.restoreAllMocks()
})

/** Minimal ownFile: only the surfaces requests_1/parse_requests_1 touch. */
function scannedFile(path: string, media: string[]): AllFile {
	return {
		path,
		file: 'content',
		original_file: 'content',
		all_notes_to_add: [],
		notes_to_edit: [],
		notes_to_delete: [],
		formatter: { detectedMedia: new Set(media) },
		getAddNotes: () => AnkiConnect.multi([]),
		getNoteInfo: () => AnkiConnect.multi([]),
		getNoteUpdates: () => AnkiConnect.multi([]),
		getDeleteNotes: () => AnkiConnect.multi([]),
		getChangeDecks: () => AnkiConnect.multi([]),
		getUpdateTags: () => AnkiConnect.multi([]),
		writeIDs: () => undefined,
		removeEmpties: () => undefined
	} as unknown as AllFile
}

describe('requests_1 media batch', () => {
	it('uploads each unique link once across files in a single batch', async () => {
		const dataFile = new TFile()
		dataFile.path = 'img.png'
		const vault = {
			read: async () => '',
			modify: vi.fn(),
			getCache: () => ({}),
			getFirstLinkpathDest: () => dataFile,
			getFullPath: () => '/abs/img.png'
		}
		const data = createParsedSettings()
		const manager = new FileManager({} as unknown as App, data, [], {}, [], { vault })
		manager.ownFiles = [scannedFile('a.md', ['img.png']), scannedFile('b.md', ['img.png', 'snd.mp3'])]
		// ownFiles is normally narrowed by initialiseFiles; drive the batch directly.
		manager.files = []

		const empty = { error: null, result: [] }
		const invokeMock = vi.fn(async (action: string) => {
			if (action === 'apiReflect') {
				return { scopes: ['actions'], actions: ['updateNote', 'updateNoteModel'] }
			}
			return [empty, empty, empty, empty, empty, empty, empty]
		})
		AnkiConnect.setTransport({ invoke: invokeMock })

		await manager.requests_1()

		const multiCalls = invokeMock.mock.calls.filter((call) => call[0] === 'multi')
		expect(multiCalls.length).toBeGreaterThan(0)
		const nested = multiCalls.flatMap((call) => {
			const actions = (call[1] as { actions: AnkiConnect.AnkiConnectRequest[] }).actions
			return Array.isArray(actions) ? actions : []
		})
		const stored = nested.flatMap((request) => {
			const actions = request.params['actions']
			return Array.isArray(actions) ? actions : [request]
		}) as Array<{ action: string; params: { filename?: string } }>
		const uploads = stored.filter((request) => request.action === 'storeMediaFile')
		expect(uploads.map((request) => request.params.filename).sort()).toEqual(['img.png', 'snd.mp3'])
		expect(manager.added_media_set.has('img.png')).toBe(true)
		expect(manager.added_media_set.has('snd.mp3')).toBe(true)
	})
})
