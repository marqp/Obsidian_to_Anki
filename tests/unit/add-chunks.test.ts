import { describe, it, expect, vi, afterEach } from 'vitest'
import * as AnkiConnect from '../../src/anki'
import { FileManager, type VaultPort } from '../../src/files-manager'
import { createParsedSettings } from './anki-test-helpers'
import type { TFile } from 'obsidian'

/**
 * A scan that adds many notes sends them in chunks and writes each chunk's IDs
 * before the next one goes: if a request times out, Anki may still add its
 * notes, and only the notes whose IDs reached the Markdown are safe from being
 * added again by the next scan.
 */

type Request = AnkiConnect.AnkiConnectRequest

function notes(count: number, prefix: string): string {
	let text = ''
	for (let i = 0; i < count; i++) {
		text += `START\nBasic\nFront: ${prefix} ${i}\nBack: a\nEND\n\n`
	}
	return text
}

function idCount(text: string | undefined): number {
	return (text ?? '').match(/ID: \d+/g)?.length ?? 0
}

function nested(request: Request): Request[] {
	return request.params['actions'] as Request[]
}

/** A chunk is [createDecks, addNotes]: its second batch holds one addNote batch per file. */
function isChunk(actions: Request[]): boolean {
	return actions.length === 2 && nested(actions[1]).some((file) => nested(file).some((a) => a.action === 'addNote'))
}

interface Harness {
	manager: FileManager
	contents: Map<string, string>
	events: string[]
	/** Decks each chunk asked Anki to create. */
	decks: string[][]
	invoke: ReturnType<typeof vi.fn>
}

async function harness(
	files: Record<string, string>,
	opts: { failChunk?: number; editDuringWrite?: string } = {}
): Promise<Harness> {
	const contents = new Map(Object.entries(files))
	const events: string[] = []
	const decks: string[][] = []
	const vault: VaultPort = {
		async read(file: TFile) {
			return contents.get(file.path) ?? ''
		},
		markdownFiles() {
			return [...contents.keys()].map((path) => ({ path }) as TFile)
		},
		async process(file: TFile, fn: (data: string) => string) {
			let current = contents.get(file.path) ?? ''
			if (opts.editDuringWrite === file.path) {
				current += '\nedited by the user'
			}
			const next = fn(current)
			contents.set(file.path, next)
			events.push(`write ${file.path}`)
			return next
		},
		getCache() {
			return {} as never
		},
		getFirstLinkpathDest() {
			return null
		},
		getFullPath(path: string) {
			return '/abs/' + path
		}
	}
	const tfiles = Object.keys(files).map((path) => ({ path, stat: { mtime: 1, size: 1 } }) as unknown as TFile)
	const manager = new FileManager({} as never, createParsedSettings(), tfiles, {}, [], {
		vault,
		notices: { notify: () => undefined }
	})
	await manager.initialiseFiles()

	let nextId = 1000
	let chunk = 0
	const invoke = vi.fn(async (action: string, params: Record<string, unknown> = {}) => {
		if (action === 'apiReflect') {
			return { scopes: ['actions'], actions: [] }
		}
		if (action !== 'multi') {
			return []
		}
		const actions = params['actions'] as Request[]
		if (isChunk(actions)) {
			chunk += 1
			const fileAdds = nested(actions[1])
			events.push(`chunk ${fileAdds.map((file) => nested(file).length).join('+')}`)
			decks.push(nested(actions[0]).map((deck) => String(deck.params['deck'])))
			if (chunk === opts.failChunk) {
				throw new Error('AnkiConnect request timed out after 30000ms: multi')
			}
			return [
				{ error: null, result: [] },
				{
					error: null,
					// Anki refuses every note whose text says "reject".
					result: fileAdds.map((file) => ({
						error: null,
						result: nested(file).map((note) =>
							JSON.stringify(note).includes('reject')
								? { error: 'cannot create note', result: null }
								: { error: null, result: nextId++ }
						)
					}))
				}
			]
		}
		if (actions.length === 7) {
			const adds = nested(actions[1]).map((file) => nested(file).length)
			events.push(`main ${adds.join('+')}`)
		}
		// Every other batch: one empty success per action, nested batches answered per entry.
		return actions.map((request) =>
			request.action === 'multi'
				? { error: null, result: nested(request).map(() => ({ error: null, result: [] })) }
				: { error: null, result: [] }
		)
	})
	AnkiConnect.setTransport({ invoke })
	return { manager, contents, events, decks, invoke }
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe('requests_1: new notes in chunks', () => {
	it('writes the IDs of each chunk before sending the next one', async () => {
		const h = await harness({ 'a.md': notes(100, 'a'), 'b.md': notes(60, 'b'), 'c.md': notes(1, 'c') })
		const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

		await h.manager.requests_1()

		expect(h.events).toEqual(['chunk 100', 'write a.md', 'chunk 60+1', 'write b.md', 'write c.md', 'main 0+0+0'])
		expect(h.decks).toEqual([['Default'], ['Default']])
		const parts = info.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('Adding'))
		expect(parts).toEqual(['Adding 100 notes to Anki (part 1 of 2)...', 'Adding 61 notes to Anki (part 2 of 2)...'])
		expect(idCount(h.contents.get('a.md'))).toBe(100)
		expect(idCount(h.contents.get('b.md'))).toBe(60)
		expect(idCount(h.contents.get('c.md'))).toBe(1)
		expect(h.manager.scanIssues).toEqual([])
	})

	it('records every chunked ID in the hashes, once', async () => {
		const h = await harness({ 'a.md': notes(100, 'a'), 'b.md': notes(60, 'b') })

		await h.manager.requests_1()

		const hashes = h.manager.getHashes()
		const ids = (path: string) => (hashes[path] as { noteIds: number[] }).noteIds
		expect(ids('a.md')).toHaveLength(100)
		expect(ids('b.md')).toHaveLength(60)
		expect(new Set([...ids('a.md'), ...ids('b.md')]).size).toBe(160)
	})

	it('keeps the IDs of the chunks already sent when a later chunk fails', async () => {
		const original = notes(60, 'b')
		const h = await harness({ 'a.md': notes(100, 'a'), 'b.md': original }, { failChunk: 2 })

		await expect(h.manager.requests_1()).rejects.toThrow('timed out')

		expect(h.events).toEqual(['chunk 100', 'write a.md', 'chunk 60'])
		expect(idCount(h.contents.get('a.md'))).toBe(100)
		expect(h.contents.get('b.md')).toBe(original)
	})

	it('sends up to 150 new notes in the one batch, as before', async () => {
		const h = await harness({ 'a.md': notes(100, 'a'), 'b.md': notes(50, 'b') })

		await h.manager.requests_1()

		expect(h.events[0]).toBe('main 100+50')
		expect(h.events.some((event) => event.startsWith('chunk'))).toBe(false)
	})

	it('fills a chunk up to exactly 150 notes', async () => {
		const h = await harness({ 'a.md': notes(100, 'a'), 'b.md': notes(50, 'b'), 'c.md': notes(1, 'c') })

		await h.manager.requests_1()

		expect(h.events.filter((event) => event.startsWith('chunk'))).toEqual(['chunk 100+50', 'chunk 1'])
	})

	it('leaves the files with no new notes out of the chunks', async () => {
		const h = await harness({ 'a.md': notes(100, 'a'), 'text.md': 'Just prose.\n', 'b.md': notes(60, 'b') })

		await h.manager.requests_1()

		expect(h.events.filter((event) => event.startsWith('chunk'))).toEqual(['chunk 100', 'chunk 60'])
		expect(h.events.at(-1)).toBe('main 0+0+0')
	})

	it('starts with a file of more than 150 notes without an empty chunk before it', async () => {
		const h = await harness({ 'a.md': notes(200, 'a'), 'b.md': notes(3, 'b') })

		await h.manager.requests_1()

		expect(h.events.filter((event) => event.startsWith('chunk'))).toEqual(['chunk 200', 'chunk 3'])
	})

	it('still removes the DELETE lines of a file whose new notes Anki refused', async () => {
		const a = 'DELETE\nID: 5\n\n' + notes(100, 'reject')
		const h = await harness({ 'a.md': a, 'b.md': notes(60, 'b') })
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)

		await h.manager.requests_1()

		expect(h.contents.get('a.md')).not.toContain('DELETE')
		expect(idCount(h.contents.get('a.md'))).toBe(0)
		expect(h.manager.scanIssues.filter((issue) => issue.kind === 'add-note' && issue.file === 'a.md')).toHaveLength(
			100
		)
		expect(idCount(h.contents.get('b.md'))).toBe(60)
	})

	it('gives a file of more than 150 notes a chunk of its own', async () => {
		const h = await harness({ 'a.md': notes(2, 'a'), 'b.md': notes(200, 'b'), 'c.md': notes(3, 'c') })

		await h.manager.requests_1()

		expect(h.events.filter((event) => event.startsWith('chunk'))).toEqual(['chunk 2', 'chunk 200', 'chunk 3'])
		expect(idCount(h.contents.get('b.md'))).toBe(200)
	})

	it('keeps an edit made while the IDs were written, reports it once and writes nothing more', async () => {
		// The DELETE line gives the final pass something to remove, so it would try to write again.
		const a = 'DELETE\nID: 5\n\n' + notes(100, 'a')
		const h = await harness({ 'a.md': a, 'b.md': notes(60, 'b') }, { editDuringWrite: 'a.md' })

		await h.manager.requests_1()

		expect(h.contents.get('a.md')).toContain('edited by the user')
		expect(h.contents.get('a.md')).toContain('DELETE\nID: 5')
		// Only the DELETE line's ID: none of the new notes got one.
		expect(idCount(h.contents.get('a.md'))).toBe(1)
		expect(h.events.filter((event) => event === 'write a.md')).toHaveLength(1)
		expect(h.manager.scanIssues).toEqual([
			{
				file: 'a.md',
				kind: 'file-changed',
				error: 'File was edited during the sync; note IDs were not written. Re-scan may create duplicate cards.'
			}
		])
		expect(idCount(h.contents.get('b.md'))).toBe(60)
	})
})
