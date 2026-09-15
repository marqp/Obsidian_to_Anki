import { describe, it, expect, vi, afterEach } from 'vitest'
import * as AnkiConnect from '../../src/anki'
import { FileManager, ScanCancelledError } from '../../src/files-manager'
import { createParsedSettings } from './anki-test-helpers'
import type { App, TFile } from 'obsidian'

function fakeApp(contents: Record<string, string>) {
	const app = {
		vault: {
			read: async (file: TFile) => contents[file.path] ?? '',
			modify: vi.fn(),
			getName: () => 'vault',
			adapter: { getFullPath: (p: string) => p }
		},
		metadataCache: { getCache: () => ({}), getFirstLinkpathDest: () => null }
	} as unknown as App
	return app
}

function fakeTFile(path: string, mtime = 200, size = 100): TFile {
	return { path, stat: { mtime, size } } as unknown as TFile
}

const BLOCK = 'START\nBasic\nFront: q\nBack: a\nEND'

describe('initialiseFiles: ScanControl progress + cooperative cancel', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('emits discover + scan progress with done/total (default control is a no-op)', async () => {
		const parsed = createParsedSettings({ delete_removed_notes: false })
		const app = fakeApp({ 'a.md': BLOCK, 'b.md': BLOCK })
		const manager = new FileManager(app, parsed, [fakeTFile('a.md'), fakeTFile('b.md')], {}, [])
		const events: Array<{ done: number; total: number; phase: string }> = []
		await manager.initialiseFiles({ onProgress: (p) => events.push({ ...p }) })

		expect(manager.ownFiles.length).toBe(2)
		expect(events.length).toBeGreaterThanOrEqual(2)
		expect(events[0]).toMatchObject({ done: 0, phase: 'discover', total: 2 })
		const last = events[events.length - 1]
		expect(last).toMatchObject({ done: 2, total: 2, phase: 'scan' })
	})

	it('stops at the next yield boundary when isCancelled flips, throwing ScanCancelledError', async () => {
		const parsed = createParsedSettings({ delete_removed_notes: false })
		const files: Record<string, string> = {}
		const tfiles: TFile[] = []
		// > VAULT_SCAN_YIELD_INTERVAL so the loop actually hits a yield point.
		for (let i = 0; i < 210; i++) {
			files[`f${i}.md`] = BLOCK
			tfiles.push(fakeTFile(`f${i}.md`, 200 + i, 100))
		}
		const app = fakeApp(files)
		const manager = new FileManager(app, parsed, tfiles, {}, [])
		let calls = 0
		const control = {
			isCancelled: () => {
				calls += 1
				return calls > 1
			}
		}
		await expect(manager.initialiseFiles(control)).rejects.toBeInstanceOf(ScanCancelledError)
		// Cancel happened mid-scan: nothing was committed to ownFiles.
		expect(manager.ownFiles).toEqual([])
	})

	it('ScanCancelledError carries the user-facing message', () => {
		expect(new ScanCancelledError().message).toBe('Scan cancelled by user.')
	})

	it('orphanFileById attributes orphans to the file that last carried them', async () => {
		const parsed = createParsedSettings({ delete_removed_notes: true, EXISTING_IDS: new Set([7, 8]) })
		const app = fakeApp({ 'gone.md': 'no blocks here' })
		const hashes = { 'gone.md': { hash: 'stale', mtime: 1, size: 1, noteIds: [7, 8] } }
		const manager = new FileManager(app, parsed, [fakeTFile('gone.md')], hashes, [])
		await manager.initialiseFiles()

		expect(manager.orphanNoteIds.sort()).toEqual([7, 8])
		const byId = manager.orphanFileById()
		expect(byId.get(7)).toBe('gone.md')
		expect(byId.get(8)).toBe('gone.md')
		expect(byId.get(999)).toBeUndefined()
	})

	it('orphanFileById is empty when there are no orphans', async () => {
		const parsed = createParsedSettings({ delete_removed_notes: false })
		const app = fakeApp({ 'a.md': BLOCK })
		const manager = new FileManager(app, parsed, [fakeTFile('a.md')], {}, [])
		await manager.initialiseFiles()

		expect(manager.orphanNoteIds).toEqual([])
		expect(manager.orphanFileById().size).toBe(0)
	})

	it('requests_1 still works after the ScanControl change (default control)', async () => {
		const parsed = createParsedSettings({ delete_removed_notes: false })
		const app = fakeApp({ 'a.md': BLOCK })
		const manager = new FileManager(app, parsed, [fakeTFile('a.md')], {}, [])
		await manager.initialiseFiles()
		expect(manager.ownFiles.length).toBe(1)
		// requests_1 needs a transport; failure mode must be a transport error,
		// not a ScanControl regression.
		AnkiConnect.setTransport({
			invoke: async () => {
				throw new Error('no-anki-in-unit-test')
			}
		})
		await expect(manager.requests_1()).rejects.toThrow('no-anki-in-unit-test')
	})
})
