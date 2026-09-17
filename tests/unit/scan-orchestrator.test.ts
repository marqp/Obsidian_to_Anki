import { describe, it, expect, vi, afterEach } from 'vitest'
import { App, TFile, TFolder } from 'obsidian'
import * as AnkiConnect from '../../src/anki'
import {
	ScanOrchestrator,
	createScanEnvironment,
	formatScanNotice,
	getAllTFilesInFolder,
	type ScanEnvironment,
	type ScanState
} from '../../src/scan-orchestrator'
import { ScanCancelledError, type FileManager, type ScanControl } from '../../src/files-manager'
import type { ParsedSettings, PluginSettings } from '../../src/interfaces/settings-interface'
import type { FileHashes } from '../../src/scan-optimizations'
import type { AllFile } from '../../src/file'
import { createParsedSettings } from './anki-test-helpers'
import { createManagerFiles } from './dry-run-helpers'

function makePluginSettings(scanDirs: string[] = []): PluginSettings {
	return {
		CUSTOM_REGEXPS: {},
		FILE_LINK_FIELDS: {},
		CONTEXT_FIELDS: {},
		FOLDER_DECKS: {},
		FOLDER_TAGS: {},
		Syntax: {
			'Begin Note': 'START',
			'End Note': 'END',
			'Begin Inline Note': 'STARTI',
			'End Inline Note': 'ENDI',
			'Target Deck Line': 'TARGET DECK',
			'File Tags Line': 'FILE TAGS',
			'Delete Note Line': 'DELETE',
			'Frozen Fields Line': 'FROZEN'
		},
		Defaults: {
			'Scan Directories': scanDirs,
			Tag: 'obsidian',
			Deck: 'Default',
			'Scheduling Interval': 0,
			'Add File Link': false,
			'Add Context': false,
			CurlyCloze: false,
			'CurlyCloze - Highlights to Clozes': false,
			'ID Comments': true,
			'Add Obsidian Tags': false,
			'Anki API Key': '',
			'Sync to AnkiWeb': false,
			'Delete Removed Notes': true,
			'Allow Note Type Changes': false,
			'Auto-launch Anki': false
		},
		IGNORED_FILE_GLOBS: []
	}
}

function tfile(path: string): TFile {
	const file = new TFile()
	file.path = path
	return file
}

interface FakeManager {
	files: TFile[]
	ownFiles: AllFile[]
	added_media_set: Set<string>
	initialiseFiles: (control?: ScanControl) => Promise<void>
	requests_1: () => Promise<void>
	getHashes: () => FileHashes
}

interface Harness {
	orchestrator: ScanOrchestrator
	notices: string[]
	infos: string[]
	committed: Array<{ media: string[]; hashes: FileHashes }>
	createdWith: TFile[][]
	fake: FakeManager
	settings: PluginSettings
	state: ScanState
}

function makeHarness(overrides: Partial<ScanEnvironment> = {}, scanDirs: string[] = []): Harness {
	const notices: string[] = []
	const infos: string[] = []
	vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
		infos.push(args.map(String).join(' '))
	})
	const settings = makePluginSettings(scanDirs)
	const state: ScanState = { settings, fieldsDict: {}, fileHashes: {}, addedMedia: [] }
	const committed: Array<{ media: string[]; hashes: FileHashes }> = []
	const createdWith: TFile[][] = []
	const fake: FakeManager = {
		files: [],
		ownFiles: [],
		added_media_set: new Set<string>(),
		initialiseFiles: () => Promise.resolve(),
		requests_1: () => Promise.resolve(),
		getHashes: () => ({})
	}
	const data = createParsedSettings()
	const env: ScanEnvironment = {
		app: new App(),
		notices: { notify: (message) => notices.push(message) },
		loadState: () => state,
		commitScanResults: (media, hashes) => committed.push({ media, hashes }),
		probeAnki: () => Promise.resolve({ status: 'ready', message: 'ok' }),
		isAutoLaunchEnabled: () => false,
		launchAnki: () => Promise.resolve('launched-pending'),
		toData: () => Promise.resolve(data),
		createManager: (_app, _data, files) => {
			createdWith.push(files)
			return fake as unknown as FileManager
		},
		...overrides
	}
	return { orchestrator: new ScanOrchestrator(env), notices, infos, committed, createdWith, fake, settings, state }
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe('formatScanNotice', () => {
	it('matches the human-readable counts format', () => {
		expect(formatScanNotice(2, 120, 5, 1, 0)).toBe('Scan complete: +5 ~1 -0 (2/120 files)')
	})
})

describe('getAllTFilesInFolder', () => {
	it('collects nested files and ignores other nodes', () => {
		const root = new TFolder()
		const direct = tfile('a.md')
		const sub = new TFolder()
		const nested = tfile('sub/b.md')
		sub.children = [nested]
		root.children = [direct, sub]
		expect(getAllTFilesInFolder(root).map((f) => f.path)).toEqual(['a.md', 'sub/b.md'])
	})

	it('returns empty for non-folders and empty folders', () => {
		expect(getAllTFilesInFolder(new TFolder()).map((f) => f.path)).toEqual([])
		expect(getAllTFilesInFolder(tfile('a.md') as unknown as TFolder)).toEqual([])
	})
})

describe('ScanOrchestrator guards', () => {
	it('refuses a second scan while one is in progress', async () => {
		const h = makeHarness()
		let release!: () => void
		h.fake.initialiseFiles = () => new Promise<void>((resolve) => (release = resolve))
		const first = h.orchestrator.scanVault()
		await new Promise((resolve) => setTimeout(resolve, 0))
		await h.orchestrator.scanVault()
		expect(h.notices).toContain('A vault scan is already in progress.')
		release()
		await first
	})

	it('runDryRun shares the same guard', async () => {
		const h = makeHarness()
		let release!: () => void
		h.fake.initialiseFiles = () => new Promise<void>((resolve) => (release = resolve))
		const first = h.orchestrator.scanVault()
		await new Promise((resolve) => setTimeout(resolve, 0))
		await h.orchestrator.runDryRun()
		expect(h.notices).toContain('A vault scan is already in progress.')
		release()
		await first
	})
})

describe('ScanOrchestrator connection probe', () => {
	it('aborts with the probe message when Anki is not ready', async () => {
		const h = makeHarness({
			probeAnki: () => Promise.resolve({ status: 'needs-key', message: 'Set the API key.' })
		})
		await h.orchestrator.scanVault()
		expect(h.notices).toEqual(['Set the API key.'])
		expect(h.createdWith).toEqual([])
	})

	it('aborts with the probe message when closed and auto-launch is off', async () => {
		const h = makeHarness({
			probeAnki: () => Promise.resolve({ status: 'closed', message: 'Open Anki and retry.' })
		})
		await h.orchestrator.scanVault()
		expect(h.notices).toEqual(['Open Anki and retry.'])
		expect(h.createdWith).toEqual([])
	})

	it('continues after a successful auto-launch', async () => {
		const h = makeHarness({
			probeAnki: () => Promise.resolve({ status: 'closed', message: 'Open Anki and retry.' }),
			isAutoLaunchEnabled: () => true,
			launchAnki: () => Promise.resolve('launched-and-ready')
		})
		await h.orchestrator.scanVault()
		expect(h.notices).toContain('Anki is now running. Continuing the scan...')
		expect(h.createdWith.length).toBe(1)
	})

	it('asks for a retry when auto-launch is still starting', async () => {
		const h = makeHarness({
			probeAnki: () => Promise.resolve({ status: 'closed', message: 'Open Anki and retry.' }),
			isAutoLaunchEnabled: () => true,
			launchAnki: () => Promise.resolve('launched-pending')
		})
		await h.orchestrator.scanVault()
		expect(h.notices).toEqual(['Anki is starting in the background. Run the scan again in a few seconds.'])
		expect(h.createdWith).toEqual([])
	})
})

describe('ScanOrchestrator pipeline', () => {
	it('scans a single file when one is given', async () => {
		const h = makeHarness()
		const file = tfile('note.md')
		await h.orchestrator.scanVault(file)
		expect(h.createdWith).toEqual([[file]])
	})

	it('resolves custom scan directories and warns on bad paths', async () => {
		const inner = tfile('notes/a.md')
		const folder = new TFolder()
		folder.path = 'notes'
		folder.children = [inner]
		const app = new App()
		app.vault.getAbstractFileByPath = (path: string) => (path === 'notes' ? folder : null)
		const h2 = makeHarness({ app }, ['notes', 'missing'])
		await h2.orchestrator.scanVault()
		expect(h2.createdWith).toEqual([[inner]])
		expect(h2.notices).toContain('Error: incorrect path for scan directory missing')
		expect(h2.infos).toContain('Using custom scan directory: notes')
	})

	it('notifies cancellation and skips the mutating pass', async () => {
		const h = makeHarness()
		h.fake.initialiseFiles = () => Promise.reject(new ScanCancelledError())
		await h.orchestrator.scanVault()
		expect(h.notices).toContain('Scan cancelled.')
		expect(h.committed).toEqual([])
	})

	it('rethrows unexpected errors and resets the guard', async () => {
		const h = makeHarness()
		h.fake.initialiseFiles = () => Promise.reject(new Error('boom'))
		await expect(h.orchestrator.scanVault()).rejects.toThrow('boom')
		// Guard was released: the next scan runs and finds nothing to do.
		h.fake.initialiseFiles = () => Promise.resolve()
		await h.orchestrator.scanVault()
		expect(h.notices).toContain('No changed files found. Nothing to sync.')
	})

	it('reports no changed files without touching Anki', async () => {
		const h = makeHarness()
		const requests = vi.fn()
		h.fake.requests_1 = requests
		await h.orchestrator.scanVault()
		expect(h.notices).toContain('No changed files found. Nothing to sync.')
		expect(requests).not.toHaveBeenCalled()
		expect(h.committed).toEqual([])
	})

	it('dry-run previews without mutating or persisting', async () => {
		const h = makeHarness()
		const data: ParsedSettings = createParsedSettings()
		h.fake.ownFiles = createManagerFiles(data, [], [{ deckName: 'Default', modelName: 'Basic' }])
		const requests = vi.fn()
		h.fake.requests_1 = requests
		// The dry-run collector reads manager.data / orphan state off FileManager.
		const manager = h.fake as unknown as Record<string, unknown>
		manager['data'] = { allow_note_type_changes: false }
		manager['orphanNoteIds'] = []
		manager['orphanFileById'] = () => new Map<number, string>()
		await h.orchestrator.runDryRun()
		expect(requests).not.toHaveBeenCalled()
		expect(h.committed).toEqual([])
		expect(h.notices).toContain('Dry-run: +1 ~0 -0 convert 0 (nothing written, see console)')
		expect(h.infos.some((line) => line.includes('[Obsidian_to_Anki] dry-run complete:'))).toBe(true)
	})

	it('syncs, logs the machine-readable line, and commits results', async () => {
		const h = makeHarness()
		const data: ParsedSettings = createParsedSettings()
		h.fake.files = [tfile('a.md'), tfile('b.md'), tfile('c.md')]
		h.fake.ownFiles = createManagerFiles(
			data,
			[{ id: 5, fields: { Front: 'Q' }, tags: [] }],
			[{ deckName: 'Default', modelName: 'Basic' }]
		)
		const getHashes = (): FileHashes => ({
			'a.md': { hash: 'h', mtime: 1, size: 1, noteIds: [] }
		})
		h.fake.getHashes = getHashes
		const requests = vi.fn()
		h.fake.requests_1 = requests
		await h.orchestrator.scanVault()
		expect(requests).toHaveBeenCalledTimes(1)
		expect(
			h.infos.some((line) =>
				line.includes('[Obsidian_to_Anki] scan complete: files_changed=1/3 added=1 updated=1 deleted=0')
			)
		).toBe(true)
		expect(h.notices).toContain('Scan complete: +1 ~1 -0 (1/3 files)')
		expect(h.committed).toEqual([{ media: [], hashes: { 'a.md': { hash: 'h', mtime: 1, size: 1, noteIds: [] } } }])
	})
})

describe('createScanEnvironment', () => {
	it('wires production defaults around plugin-owned state', async () => {
		const state: ScanState = {
			settings: makePluginSettings(),
			fieldsDict: {},
			fileHashes: {},
			addedMedia: []
		}
		const committed: Array<{ media: string[]; hashes: FileHashes }> = []
		const env = createScanEnvironment(
			new App(),
			{
				loadState: () => state,
				commitScanResults: (media, hashes) => committed.push({ media, hashes })
			},
			{ isAutoLaunchEnabled: () => false }
		)
		expect(env.loadState()).toBe(state)
		env.commitScanResults(['x.png'], {})
		expect(committed).toEqual([{ media: ['x.png'], hashes: {} }])
		// Production manager factory over empty input.
		const manager = env.createManager(env.app, createParsedSettings(), [], {}, [])
		expect(manager.files).toEqual([])
	})

	it('production defaults probe, launch-guard and parse settings', async () => {
		AnkiConnect.setTransport({
			invoke: async (action: string) => {
				if (action === 'requestPermission') {
					return { permission: 'granted', version: 6 }
				}
				return []
			}
		})
		const state: ScanState = {
			settings: makePluginSettings(),
			fieldsDict: {},
			fileHashes: {},
			addedMedia: []
		}
		const env = createScanEnvironment(
			new App(),
			{ loadState: () => state, commitScanResults: () => undefined },
			{ isAutoLaunchEnabled: () => false }
		)
		const probe = await env.probeAnki()
		expect(probe.status).toBe('ready')
		await expect(env.launchAnki(false)).resolves.toBe('skipped-disabled')
		const data = await env.toData(env.app, state.settings, {})
		expect(data.vault_name).toBe('test-vault')
		expect(data.EXISTING_IDS.size).toBe(0)
	})
})
