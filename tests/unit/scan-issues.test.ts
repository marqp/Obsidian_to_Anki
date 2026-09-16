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

/** FileManager with one file carrying a single pending add. */
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
})
