import { describe, it, expect, vi, afterEach } from 'vitest'
import { TFile, type App } from 'obsidian'
import * as AnkiConnect from '../../src/anki'
import { FileManager } from '../../src/files-manager'
import { hashBytes, MEDIA_CHECKS_PER_SCAN, type MediaRecords } from '../../src/media-records'
import { createParsedSettings } from './anki-test-helpers'

afterEach(() => {
	vi.restoreAllMocks()
})

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

function hash(text: string): string {
	return hashBytes(bytes(text))
}

const OLD_STAT = { mtime: 1, size: 3 }
const NEW_STAT = { ctime: 0, mtime: 2, size: 3 }

function recordOf(content: string | null, path = 'img.png') {
	return { path, hash: content === null ? null : hash(content), ...OLD_STAT }
}

interface Setup {
	/** Text of each vault file, by path. A link resolves to a file of that exact path. */
	vault: Record<string, string>
	/** Text of each file in Anki, by name; a missing entry means Anki does not have it. */
	anki?: Record<string, string>
	records?: MediaRecords
	added?: string[]
	stat?: { ctime: number; mtime: number; size: number }
	readBinary?: (file: TFile) => Promise<ArrayBuffer>
	/** Fails storeMediaFile with this message. */
	storeFails?: string
}

function managerFor(setup: Setup) {
	const anki = { ...(setup.anki ?? {}) }
	const port = {
		read: async () => '',
		process: vi.fn(),
		getCache: () => ({}),
		getFirstLinkpathDest: (link: string) => {
			if (setup.vault[link] === undefined) {
				return null
			}
			const file = new TFile()
			file.path = link
			file.stat = setup.stat ?? NEW_STAT
			return file
		},
		getFullPath: (path: string) => `/abs/${path}`,
		readBinary:
			setup.readBinary ?? (async (file: TFile) => bytes(setup.vault[file.path] ?? '').buffer as ArrayBuffer)
	}
	const manager = new FileManager({} as unknown as App, createParsedSettings(), [], {}, setup.added ?? [], {
		vault: port
	})
	manager.mediaRecords = setup.records ?? {}
	const invoke = vi.fn(async (action: string, params: { filename?: string; path?: string }) => {
		if (action === 'retrieveMediaFile') {
			const held = anki[params.filename ?? '']
			return held === undefined ? false : Buffer.from(held).toString('base64')
		}
		if (action === 'storeMediaFile') {
			if (setup.storeFails) {
				throw new Error(setup.storeFails)
			}
			return params.filename
		}
		return null
	})
	AnkiConnect.setTransport({ invoke: invoke as never })
	const stored = () => invoke.mock.calls.filter((call) => call[0] === 'storeMediaFile').map((call) => call[1])
	return { manager, invoke, stored }
}

describe('refreshChangedMedia', () => {
	it('sends a file that changed in the vault while Anki kept what was sent', async () => {
		const { manager, stored } = managerFor({
			vault: { 'img.png': 'new' },
			anki: { 'img.png': 'old' },
			records: { 'img.png': recordOf('old') },
			added: ['img.png']
		})
		await manager.refreshChangedMedia()
		expect(stored()).toEqual([{ filename: 'img.png', path: '/abs/img.png' }])
		expect(manager.resentMedia).toEqual(['img.png'])
		expect(manager.scanIssues).toEqual([])
		expect(manager.mediaRecords['img.png']).toEqual({ path: 'img.png', hash: hash('new'), mtime: 2, size: 3 })
		expect(manager.mediaRecordsChanged).toBe(true)
	})

	it('sends under the bare name, as Anki keeps no folders', async () => {
		const { manager, stored } = managerFor({
			vault: { 'folder/img.png': 'new' },
			anki: { 'img.png': 'old' },
			records: { 'folder/img.png': recordOf('old', 'folder/img.png') }
		})
		await manager.refreshChangedMedia()
		expect(stored()).toEqual([{ filename: 'img.png', path: '/abs/folder/img.png' }])
	})

	it('reports and never sends when Anki changed too', async () => {
		const { manager, stored } = managerFor({
			vault: { 'img.png': 'new' },
			anki: { 'img.png': 'edited in anki' },
			records: { 'img.png': recordOf('old') }
		})
		await manager.refreshChangedMedia()
		expect(stored()).toEqual([])
		expect(manager.resentMedia).toEqual([])
		expect(manager.scanIssues).toEqual([
			{
				file: 'img.png',
				kind: 'media-differs',
				error: "img.png in the vault differs from the file of that name in Anki, and notes in Anki show Anki's file."
			}
		])
	})

	it('reports and never sends when Anki lost the file', async () => {
		const { manager, stored } = managerFor({
			vault: { 'img.png': 'new' },
			records: { 'img.png': recordOf('old') }
		})
		await manager.refreshChangedMedia()
		expect(stored()).toEqual([])
		expect(manager.scanIssues).toEqual([
			{ file: 'img.png', kind: 'media-differs', error: "img.png is in the vault but not in Anki's media folder." }
		])
	})

	it('reports a difference once: the next scan does not read the file again', async () => {
		const readBinary = vi.fn(async () => bytes('new').buffer as ArrayBuffer)
		const first = managerFor({
			vault: { 'img.png': 'new' },
			anki: { 'img.png': 'other' },
			records: { 'img.png': recordOf('old') },
			readBinary
		})
		await first.manager.refreshChangedMedia()
		expect(first.manager.mediaRecords['img.png'].hash).toBeNull()

		const second = managerFor({
			vault: { 'img.png': 'new' },
			anki: { 'img.png': 'other' },
			records: first.manager.mediaRecords,
			readBinary
		})
		readBinary.mockClear()
		await second.manager.refreshChangedMedia()
		expect(readBinary).not.toHaveBeenCalled()
		expect(second.manager.scanIssues).toEqual([])
	})

	it('never sends over a file whose last comparison differed, even after the vault changes', async () => {
		const { manager, stored } = managerFor({
			vault: { 'img.png': 'newer' },
			anki: { 'img.png': 'other' },
			records: { 'img.png': recordOf(null) }
		})
		await manager.refreshChangedMedia()
		expect(stored()).toEqual([])
		expect(manager.scanIssues.map((issue) => issue.kind)).toEqual(['media-differs'])
	})

	it('updates only the stat when a file was touched but its bytes are the same', async () => {
		const { manager, invoke, stored } = managerFor({
			vault: { 'img.png': 'old' },
			records: { 'img.png': recordOf('old') }
		})
		await manager.refreshChangedMedia()
		expect(invoke).not.toHaveBeenCalled()
		expect(stored()).toEqual([])
		expect(manager.mediaRecords['img.png'].mtime).toBe(2)
		expect(manager.scanIssues).toEqual([])
	})

	it('reads nothing when the stat still matches', async () => {
		const readBinary = vi.fn(async () => new ArrayBuffer(0))
		const { manager, invoke } = managerFor({
			vault: { 'img.png': 'new' },
			records: { 'img.png': recordOf('old') },
			stat: { ctime: 0, ...OLD_STAT },
			readBinary
		})
		await manager.refreshChangedMedia()
		expect(readBinary).not.toHaveBeenCalled()
		expect(invoke).not.toHaveBeenCalled()
		expect(manager.mediaRecordsChanged).toBe(false)
	})

	it('accepts a change that already reached Anki, without sending it', async () => {
		const { manager, stored } = managerFor({
			vault: { 'img.png': 'new' },
			anki: { 'img.png': 'new' },
			records: { 'img.png': recordOf('old') }
		})
		await manager.refreshChangedMedia()
		expect(stored()).toEqual([])
		expect(manager.resentMedia).toEqual([])
		expect(manager.mediaRecords['img.png'].hash).toBe(hash('new'))
	})

	it('keeps the record and reports when sending fails, so the next scan retries', async () => {
		const records = { 'img.png': recordOf('old') }
		const { manager } = managerFor({
			vault: { 'img.png': 'new' },
			anki: { 'img.png': 'old' },
			records,
			storeFails: 'disk full'
		})
		await manager.refreshChangedMedia()
		expect(manager.resentMedia).toEqual([])
		expect(manager.mediaRecords['img.png']).toEqual(recordOf('old'))
		expect(manager.scanIssues).toEqual([
			{ file: 'img.png', kind: 'media', error: 'Could not compare img.png: disk full' }
		])
	})

	it('keeps checking after one file fails', async () => {
		const { manager, stored } = managerFor({
			vault: { 'bad.png': 'x', 'img.png': 'new' },
			anki: { 'img.png': 'old' },
			records: { 'bad.png': recordOf('y', 'bad.png'), 'img.png': recordOf('old') },
			readBinary: async (file) => {
				if (file.path === 'bad.png') {
					throw new Error('disk error')
				}
				return bytes('new').buffer as ArrayBuffer
			}
		})
		await manager.refreshChangedMedia()
		expect(stored().map((params) => params.filename)).toEqual(['img.png'])
		expect(manager.scanIssues).toEqual([
			{ file: 'bad.png', kind: 'media', error: 'Could not compare bad.png: disk error' }
		])
	})

	describe('a file with no record', () => {
		it('gets a record when Anki holds the same bytes, and a later change is sent', async () => {
			const first = managerFor({
				vault: { 'img.png': 'same' },
				anki: { 'img.png': 'same' },
				added: ['img.png']
			})
			await first.manager.refreshChangedMedia()
			expect(first.stored()).toEqual([])
			expect(first.manager.scanIssues).toEqual([])
			expect(first.manager.mediaRecords['img.png'].hash).toBe(hash('same'))

			const later = managerFor({
				vault: { 'img.png': 'edited' },
				anki: { 'img.png': 'same' },
				added: ['img.png'],
				records: first.manager.mediaRecords,
				stat: { ctime: 0, mtime: 9, size: 6 }
			})
			await later.manager.refreshChangedMedia()
			expect(later.manager.resentMedia).toEqual(['img.png'])
		})

		it('is reported and never sent when Anki holds other bytes', async () => {
			const { manager, stored } = managerFor({
				vault: { 'img.png': 'vault' },
				anki: { 'img.png': 'anki' },
				added: ['img.png']
			})
			await manager.refreshChangedMedia()
			expect(stored()).toEqual([])
			expect(manager.scanIssues.map((issue) => issue.kind)).toEqual(['media-differs'])
			expect(manager.mediaRecords['img.png'].hash).toBeNull()
		})

		it('is skipped when no vault file matches the link', async () => {
			const { manager, invoke } = managerFor({ vault: {}, added: ['gone.png'] })
			await manager.refreshChangedMedia()
			expect(invoke).not.toHaveBeenCalled()
			expect(manager.scanIssues).toEqual([])
		})
	})

	it('treats a moved file as unrecorded, so a different file at the new path is not sent', async () => {
		const { manager, stored } = managerFor({
			vault: { 'img.png': 'another file' },
			anki: { 'img.png': 'old' },
			records: { 'img.png': recordOf('old', 'old-folder/img.png') }
		})
		await manager.refreshChangedMedia()
		expect(stored()).toEqual([])
		expect(manager.scanIssues.map((issue) => issue.kind)).toEqual(['media-differs'])
		expect(manager.mediaRecords['img.png'].path).toBe('img.png')
	})

	it('does not send one of two files sharing a name when Anki holds the other', async () => {
		const { manager, stored } = managerFor({
			vault: { 'one/img.png': 'first, edited', 'two/img.png': 'second' },
			anki: { 'img.png': 'second' },
			records: {
				'one/img.png': recordOf('first', 'one/img.png'),
				'two/img.png': { ...recordOf('second', 'two/img.png'), ...NEW_STAT }
			}
		})
		await manager.refreshChangedMedia()
		expect(stored()).toEqual([])
		expect(manager.scanIssues.map((issue) => [issue.file, issue.kind])).toEqual([['one/img.png', 'media-differs']])
	})

	it('limits the comparisons per scan, serving changed files before unrecorded ones', async () => {
		const unrecorded = Array.from({ length: MEDIA_CHECKS_PER_SCAN + 5 }, (_, i) => `u${i}.png`)
		const vault = Object.fromEntries(unrecorded.map((link) => [link, 'same']))
		const anki = { ...vault, 'changed.png': 'old' }
		const { manager, invoke } = managerFor({
			vault: { ...vault, 'changed.png': 'new' },
			anki,
			added: unrecorded,
			records: { 'changed.png': recordOf('old', 'changed.png') }
		})
		await manager.refreshChangedMedia()
		const compared = invoke.mock.calls.filter((call) => call[0] === 'retrieveMediaFile')
		expect(compared).toHaveLength(MEDIA_CHECKS_PER_SCAN)
		expect(manager.resentMedia).toEqual(['changed.png'])
		expect(Object.keys(manager.mediaRecords)).toHaveLength(MEDIA_CHECKS_PER_SCAN)
	})

	it('keeps its problems in the scan issues after requests_1 resets them', async () => {
		const { manager, invoke } = managerFor({
			vault: { 'img.png': 'new' },
			anki: { 'img.png': 'other' },
			records: { 'img.png': recordOf('old') }
		})
		await manager.refreshChangedMedia()
		invoke.mockImplementation(async (action: string) => {
			if (action === 'apiReflect') {
				return { scopes: ['actions'], actions: [] } as never
			}
			const empty = { error: null, result: [] }
			return [empty, empty, empty, empty, empty, empty, empty] as never
		})
		await manager.requests_1()
		expect(manager.scanIssues.map((issue) => issue.kind)).toEqual(['media-differs'])
	})
})

describe('planChangedMedia', () => {
	it('names what a scan would send and writes nothing', async () => {
		const records = { 'img.png': recordOf('old') }
		const { manager, stored } = managerFor({
			vault: { 'folder/x.png': 'x', 'img.png': 'new' },
			anki: { 'img.png': 'old' },
			records
		})
		const plan = await manager.planChangedMedia()
		expect(plan.resent).toEqual(['img.png'])
		expect([...plan.paths]).toEqual(['img.png'])
		expect(plan.issues).toEqual([])
		expect(stored()).toEqual([])
		expect(manager.resentMedia).toEqual([])
		expect(manager.mediaRecords).toEqual({ 'img.png': recordOf('old') })
		expect(manager.mediaRecordsChanged).toBe(false)
	})

	it('reports what a scan would refuse to send', async () => {
		const { manager } = managerFor({
			vault: { 'img.png': 'new' },
			anki: { 'img.png': 'other' },
			records: { 'img.png': recordOf('old') }
		})
		const plan = await manager.planChangedMedia()
		expect(plan.resent).toEqual([])
		expect(plan.paths.size).toBe(0)
		expect(plan.issues.map((issue) => issue.kind)).toEqual(['media-differs'])
	})

	it('leaves files with no record to the real scan, so a dry-run stays quick', async () => {
		const { manager, invoke } = managerFor({
			vault: { 'unrecorded.png': 'x', 'unknown.png': 'y' },
			added: ['unrecorded.png'],
			records: { 'unknown.png': recordOf(null, 'unknown.png') }
		})
		const plan = await manager.planChangedMedia()
		expect(invoke).not.toHaveBeenCalled()
		expect(plan).toEqual({ resent: [], paths: new Set(), issues: [] })
	})

	it('reports a failed comparison instead of aborting', async () => {
		const { manager } = managerFor({
			vault: { 'img.png': 'new' },
			records: { 'img.png': recordOf('old') },
			readBinary: async () => {
				throw new Error('disk error')
			}
		})
		const plan = await manager.planChangedMedia()
		expect(plan.issues).toEqual([
			{ file: 'img.png', kind: 'media', error: 'Could not compare img.png: disk error' }
		])
	})
})

describe('syncToAnkiWeb', () => {
	it('does nothing when the setting is off', async () => {
		const { manager, invoke } = managerFor({ vault: {} })
		await manager.syncToAnkiWeb()
		expect(invoke).not.toHaveBeenCalled()
	})

	it('syncs when the setting is on', async () => {
		const { manager, invoke } = managerFor({ vault: {} })
		manager.data.sync_to_ankiweb = true
		await manager.syncToAnkiWeb()
		expect(invoke.mock.calls.map((call) => call[0])).toEqual(['sync'])
	})

	it('turns a failed sync into an issue', async () => {
		const { manager, invoke } = managerFor({ vault: {} })
		manager.data.sync_to_ankiweb = true
		invoke.mockRejectedValue(new Error('offline'))
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		await manager.syncToAnkiWeb()
		expect(manager.scanIssues).toEqual([{ file: '', kind: 'ankiweb-sync', error: 'offline' }])
	})
})
