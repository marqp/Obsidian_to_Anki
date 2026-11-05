import { describe, it, expect, vi, afterEach } from 'vitest'
import { TFile, type App } from 'obsidian'
import * as AnkiConnect from '../../src/anki'
import { FileManager } from '../../src/files-manager'
import { createParsedSettings } from './anki-test-helpers'
import type { AllFile } from '../../src/file'

afterEach(() => {
	vi.restoreAllMocks()
})

function bytes(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer as ArrayBuffer
}

function base64(text: string): string {
	return Buffer.from(text).toString('base64')
}

interface Setup {
	/** Which files each Markdown file cites. */
	citing: Record<string, string[]>
	/** Vault path each link resolves to; a missing entry means the link resolves to nothing. */
	resolves?: Record<string, string>
	/** Bytes of each vault file, by vault path. */
	vault?: Record<string, string>
	/** Base64 of each file in Anki, by name; a missing entry means Anki does not have it. */
	anki?: Record<string, string>
	readBinary?: (file: TFile) => Promise<ArrayBuffer>
}

function managerFor(setup: Setup) {
	const located = (path: string): TFile => {
		const file = new TFile()
		file.path = path
		return file
	}
	const port = {
		read: async () => '',
		process: vi.fn(),
		getCache: () => ({}),
		getFirstLinkpathDest: (link: string) => {
			const path = (setup.resolves ?? {})[link] ?? (setup.resolves === undefined ? link : undefined)
			return path === undefined ? null : located(path)
		},
		getFullPath: (path: string) => `/abs/${path}`,
		readBinary: setup.readBinary ?? (async (file: TFile) => bytes((setup.vault ?? {})[file.path] ?? ''))
	}
	const manager = new FileManager({} as unknown as App, createParsedSettings(), [], {}, [], { vault: port })
	manager.ownFiles = Object.entries(setup.citing).map(
		([path, media]) => ({ path, formatter: { detectedMedia: new Set(media) } }) as unknown as AllFile
	)
	const invoke = vi.fn(async (_action: string, params: { filename?: string }) => {
		return (setup.anki ?? {})[params.filename ?? ''] ?? false
	})
	AnkiConnect.setTransport({ invoke: invoke as never })
	return { manager, invoke }
}

describe('findMediaDifferences', () => {
	it('stays quiet when the bytes match', async () => {
		const { manager } = managerFor({
			citing: { 'a.md': ['img.png'] },
			vault: { 'img.png': 'same' },
			anki: { 'img.png': base64('same') }
		})
		expect(await manager.findMediaDifferences()).toEqual([])
	})

	it('reports a file whose bytes differ, naming the file and the note file citing it', async () => {
		const { manager } = managerFor({
			citing: { 'a.md': ['folder/img.png'] },
			vault: { 'folder/img.png': 'new' },
			anki: { 'img.png': base64('old') }
		})
		expect(await manager.findMediaDifferences()).toEqual([
			{
				file: 'a.md',
				kind: 'media-differs',
				error: "img.png in the vault differs from the file of that name in Anki, and notes in Anki show Anki's file."
			}
		])
	})

	it('reports a file Anki does not have', async () => {
		const { manager } = managerFor({ citing: { 'a.md': ['img.png'] }, vault: { 'img.png': 'x' } })
		expect(await manager.findMediaDifferences()).toEqual([
			{ file: 'a.md', kind: 'media-differs', error: "img.png is in the vault but not in Anki's media folder." }
		])
	})

	it('reports a link the vault cannot resolve, once per citing file, without asking Anki', async () => {
		const { manager, invoke } = managerFor({
			citing: { 'a.md': ['gone.png'], 'b.md': ['gone.png'] },
			resolves: {}
		})
		const issues = await manager.findMediaDifferences()
		expect(issues).toEqual([
			{ file: 'a.md', kind: 'media-missing', error: "Couldn't locate media file gone.png" },
			{ file: 'b.md', kind: 'media-missing', error: "Couldn't locate media file gone.png" }
		])
		expect(invoke).not.toHaveBeenCalled()
	})

	it('compares a file cited by several notes once', async () => {
		const { manager, invoke } = managerFor({
			citing: { 'a.md': ['img.png'], 'b.md': ['img.png'] },
			vault: { 'img.png': 'new' },
			anki: { 'img.png': base64('old') }
		})
		const issues = await manager.findMediaDifferences()
		expect(issues.map((issue) => issue.file)).toEqual(['a.md'])
		expect(invoke).toHaveBeenCalledTimes(1)
	})

	it('compares two vault files with one name separately, since Anki holds only one of them', async () => {
		const { manager } = managerFor({
			citing: { 'a.md': ['one/img.png'], 'b.md': ['two/img.png'] },
			vault: { 'one/img.png': 'first', 'two/img.png': 'second' },
			anki: { 'img.png': base64('first') }
		})
		const issues = await manager.findMediaDifferences()
		expect(issues.map((issue) => [issue.file, issue.kind])).toEqual([['b.md', 'media-differs']])
	})

	it('leaves out the files a real scan would send', async () => {
		const { manager, invoke } = managerFor({
			citing: { 'a.md': ['planned.png', 'img.png'] },
			vault: { 'planned.png': 'new', 'img.png': 'new' },
			anki: { 'planned.png': base64('old'), 'img.png': base64('old') }
		})
		const issues = await manager.findMediaDifferences(new Set(['planned.png']))
		expect(issues.map((issue) => issue.error)).toEqual([
			"img.png in the vault differs from the file of that name in Anki, and notes in Anki show Anki's file."
		])
		expect(invoke).toHaveBeenCalledTimes(1)
	})

	it('keeps comparing after a read fails, and reports the failure', async () => {
		const { manager } = managerFor({
			citing: { 'a.md': ['bad.png', 'img.png'] },
			vault: { 'img.png': 'new' },
			anki: { 'bad.png': base64('x'), 'img.png': base64('old') },
			readBinary: async (file) => {
				if (file.path === 'bad.png') {
					throw new Error('disk error')
				}
				return bytes('new')
			}
		})
		expect((await manager.findMediaDifferences()).map((issue) => [issue.kind, issue.error])).toEqual([
			['media', 'Could not compare bad.png: disk error'],
			[
				'media-differs',
				"img.png in the vault differs from the file of that name in Anki, and notes in Anki show Anki's file."
			]
		])
	})

	it('only reads: the one action it sends to Anki is retrieveMediaFile', async () => {
		const { manager, invoke } = managerFor({
			citing: { 'a.md': ['one.png', 'two.png'] },
			vault: { 'one.png': 'a', 'two.png': 'b' },
			anki: { 'one.png': base64('a') }
		})
		await manager.findMediaDifferences()
		expect(new Set(invoke.mock.calls.map((call) => call[0]))).toEqual(new Set(['retrieveMediaFile']))
		expect(manager.added_media_set.size).toBe(0)
	})
})
