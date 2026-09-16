import { describe, it, expect, vi, afterEach } from 'vitest'
import * as AnkiConnect from '../../src/anki'
import { FileManager, ScanCancelledError, type VaultPort } from '../../src/files-manager'
import { createParsedSettings } from './anki-test-helpers'
import type { FileData } from '../../src/interfaces/settings-interface'
import type { TFile } from 'obsidian'

/**
 * Runs the scan pipeline against a fake VaultPort: no App, no Electron, no
 * Anki. This is the seam that makes initialiseFiles/orphan logic testable.
 */
interface FakeVault extends VaultPort {
	reads: string[]
	modifies: Array<{ path: string; data: string }>
	contents: Map<string, string>
	caches: Map<string, Record<string, unknown>>
}

function fakeVault(contents: Record<string, string>, caches: Record<string, object> = {}): FakeVault {
	const reads: string[] = []
	const modifies: Array<{ path: string; data: string }> = []
	return {
		reads,
		modifies,
		contents: new Map(Object.entries(contents)),
		caches: new Map(Object.entries(caches).map(([k, v]) => [k, v as Record<string, unknown>])),
		async read(file: TFile) {
			reads.push(file.path)
			return this.contents.get(file.path) ?? ''
		},
		async modify(file: TFile, data: string) {
			modifies.push({ path: file.path, data })
		},
		getCache(path: string) {
			return (this.caches.get(path) ?? {}) as never
		},
		getFirstLinkpathDest() {
			return null
		},
		getFullPath(path: string) {
			return '/abs/' + path
		}
	}
}

function tfile(path: string, stat: { mtime: number; size: number }): TFile {
	return { path, stat } as unknown as TFile
}

const NOTE = 'START\nBasic\nFront: Q\nBack: A\nEND\n'

afterEach(() => {
	vi.restoreAllMocks()
})

describe('FileManager with injected VaultPort (no Obsidian)', () => {
	it('skips files whose stat matches the stored hash entry', async () => {
		const content = NOTE
		const vault = fakeVault({ 'a.md': content })
		const data = createParsedSettings()
		const file = tfile('a.md', { mtime: 111, size: content.length })
		const manager = new FileManager(
			{} as never,
			data,
			[file],
			{
				'a.md': { hash: 'whatever', mtime: 111, size: content.length, noteIds: [] }
			},
			[],
			{ vault }
		)

		await manager.initialiseFiles()

		expect(vault.reads).toEqual([])
		expect(manager.ownFiles).toEqual([])
	})

	it('reads and scans changed files, reporting progress and skipping unchanged hashes', async () => {
		const vault = fakeVault({ 'a.md': NOTE, 'b.md': NOTE.replace('Q', 'Q2') })
		const data = createParsedSettings()
		const files = [tfile('a.md', { mtime: 1, size: 1 }), tfile('b.md', { mtime: 2, size: 1 })]
		const progress: string[] = []
		const manager = new FileManager({} as never, data, files, {}, [], { vault })

		await manager.initialiseFiles({ onProgress: (p) => progress.push(`${p.phase}:${p.done}/${p.total}`) })

		expect(vault.reads.sort()).toEqual(['a.md', 'b.md'])
		expect(manager.ownFiles.map((f) => f.path).sort()).toEqual(['a.md', 'b.md'])
		expect(progress).toContain('discover:0/2')
		expect(progress).toContain('scan:2/2')
	})

	it('honours cancellation between read and scan passes', async () => {
		const vault = fakeVault({ 'a.md': NOTE })
		const data = createParsedSettings()
		const manager = new FileManager({} as never, data, [tfile('a.md', { mtime: 1, size: 1 })], {}, [], { vault })

		await expect(manager.initialiseFiles({ isCancelled: () => true })).rejects.toBeInstanceOf(ScanCancelledError)
		expect(manager.ownFiles).toEqual([])
	})

	it('computes orphans from stored records without any Obsidian dependency', async () => {
		const vault = fakeVault({ 'a.md': 'no notes here anymore\n' })
		const data = createParsedSettings({ delete_removed_notes: true, EXISTING_IDS: new Set([7, 8]) })
		const manager = new FileManager(
			{} as never,
			data,
			[tfile('a.md', { mtime: 5, size: 1 })],
			{
				'a.md': { hash: 'old', mtime: 1, size: 1, noteIds: [7, 8] }
			},
			[],
			{ vault }
		)

		await manager.initialiseFiles()

		// Both IDs disappeared from the file and still exist in Anki -> orphans.
		expect(manager.orphanNoteIds.sort()).toEqual([7, 8])
		expect(manager.orphanFileById().get(7)).toBe('a.md')
	})

	it('never orphans IDs still present in the file text', async () => {
		const vault = fakeVault({ 'a.md': `${NOTE}<!--ID: 7-->\n` })
		const data = createParsedSettings({ delete_removed_notes: true, EXISTING_IDS: new Set([7]) })
		const manager = new FileManager(
			{} as never,
			data,
			[tfile('a.md', { mtime: 5, size: 1 })],
			{
				'a.md': { hash: 'old', mtime: 1, size: 1, noteIds: [7] }
			},
			[],
			{ vault }
		)

		await manager.initialiseFiles()

		expect(manager.orphanNoteIds).toEqual([])
	})

	it('routes the AnkiWeb failure notice through the injected port', async () => {
		const vault = fakeVault({})
		const notify = vi.fn()
		const data = createParsedSettings({ sync_to_ankiweb: true })
		const manager = new FileManager({} as never, data, [], {}, [], { vault, notices: { notify } })
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		AnkiConnect.setTransport({
			invoke: async (action: string) => {
				if (action === 'sync') {
					throw new Error('AnkiWeb offline')
				}
				return []
			}
		})

		await manager.requests_2()

		expect(notify).toHaveBeenCalledWith(expect.stringContaining('AnkiWeb sync failed'))
	})
})

describe('VaultPort helpers', () => {
	it('exposes the parsed file data untouched (sanity for fake plumbing)', () => {
		const data: FileData = createParsedSettings() as FileData
		expect(data.vault_name).toBe('test-vault')
	})
})
