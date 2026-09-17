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
	function mediaManager(
		files: Array<{ path: string; media: string[] }>,
		dest: (link: string) => TFile | null,
		mediaResult: unknown[]
	) {
		const vault = {
			read: async () => '',
			modify: vi.fn(),
			getCache: () => ({}),
			getFirstLinkpathDest: (link: string) => dest(link),
			getFullPath: (path: string) => `/abs/${path}`
		}
		const manager = new FileManager({} as unknown as App, createParsedSettings(), [], {}, [], { vault })
		manager.ownFiles = files.map((f) => scannedFile(f.path, f.media))
		// ownFiles is normally narrowed by initialiseFiles; drive the batch directly.
		manager.files = []
		const empty = { error: null, result: [] }
		const multiResponse = [empty, empty, empty, empty, empty, empty, { error: null, result: mediaResult }]
		const invokeMock = vi.fn(async (action: string) => {
			if (action === 'apiReflect') {
				return { scopes: ['actions'], actions: ['updateNote', 'updateNoteModel'] }
			}
			return multiResponse
		})
		AnkiConnect.setTransport({ invoke: invokeMock })
		return { manager, invokeMock }
	}

	function uploadedFilenames(invokeMock: ReturnType<typeof vi.fn>): Array<string | undefined> {
		const multiCalls = invokeMock.mock.calls.filter((call) => call[0] === 'multi')
		const nested = multiCalls.flatMap((call) => {
			const actions = (call[1] as { actions: AnkiConnect.AnkiConnectRequest[] }).actions
			return Array.isArray(actions) ? actions : []
		})
		const stored = nested.flatMap((request) => {
			const actions = request.params['actions']
			return Array.isArray(actions) ? actions : [request]
		}) as Array<{ action: string; params: { filename?: string } }>
		return stored.filter((request) => request.action === 'storeMediaFile').map((request) => request.params.filename)
	}

	function locatedFile(path: string): TFile {
		const dataFile = new TFile()
		dataFile.path = path
		return dataFile
	}

	it('uploads each unique link once across files in a single batch', async () => {
		const { manager, invokeMock } = mediaManager(
			[
				{ path: 'a.md', media: ['img.png'] },
				{ path: 'b.md', media: ['img.png', 'snd.mp3'] }
			],
			(link) => locatedFile(link),
			[]
		)

		await manager.requests_1()

		expect(uploadedFilenames(invokeMock).sort()).toEqual(['img.png', 'snd.mp3'])
		expect(manager.added_media_set.has('img.png')).toBe(true)
		expect(manager.added_media_set.has('snd.mp3')).toBe(true)
		expect(manager.scanIssues).toEqual([])
	})

	it('attributes a failed upload to its file and still completes', async () => {
		const { manager } = mediaManager(
			[
				{ path: 'a.md', media: ['img.png'] },
				{ path: 'b.md', media: ['img.png', 'snd.mp3'] }
			],
			(link) => locatedFile(link),
			[{ error: null }, { error: 'disk full' }]
		)
		vi.spyOn(console, 'error').mockImplementation(() => undefined)

		await manager.requests_1()

		expect(manager.scanIssues).toEqual([{ file: 'b.md', kind: 'media', error: 'disk full' }])
		// Both links were located, so both stay marked as added.
		expect(manager.added_media_set.has('img.png')).toBe(true)
		expect(manager.added_media_set.has('snd.mp3')).toBe(true)
	})

	it('records unlocatable media as an issue instead of only warning', async () => {
		const { manager } = mediaManager(
			[{ path: 'c.md', media: ['img.png', 'ghost.png'] }],
			(link) => (link === 'ghost.png' ? null : locatedFile(link)),
			[{ error: null }]
		)
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

		await manager.requests_1()

		expect(manager.scanIssues).toEqual([
			{ file: 'c.md', kind: 'media-missing', error: "Couldn't locate media file ghost.png" }
		])
		// Legacy warn preserved alongside the structured issue.
		expect(warnSpy.mock.calls.some((args) => String(args[0]).includes("Couldn't locate media file"))).toBe(true)
		expect(manager.added_media_set.has('img.png')).toBe(true)
		expect(manager.added_media_set.has('ghost.png')).toBe(false)
	})
})
