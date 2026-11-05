import { describe, it, expect, vi, afterEach } from 'vitest'
import { App, TFile, TFolder } from 'obsidian'
import * as AnkiConnect from '../../src/anki'
import {
	ScanOrchestrator,
	createScanEnvironment,
	formatScanIssues,
	formatScanNotice,
	getAllTFilesInFolder,
	type PreviewCallbacks,
	type ScanEnvironment,
	type ScanState
} from '../../src/scan-orchestrator'
import type { DryRunSummary } from '../../src/dry-run'
import { ScanCancelledError, type FileManager, type ScanControl, type ScanIssue } from '../../src/files-manager'
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
			'Auto-launch Anki': false,
			'Confirm Before Sync': false
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
	scanIssues: ScanIssue[]
	orphanNoteIds: number[]
	added_media_set: Set<string>
	initialiseFiles: (control?: ScanControl) => Promise<void>
	requests_1: () => Promise<void>
	getHashes: () => FileHashes
	updatedNoteCount: () => number
	failedDeleteCount: number
	convertedCount: number
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
		scanIssues: [],
		orphanNoteIds: [],
		added_media_set: new Set<string>(),
		initialiseFiles: () => Promise.resolve(),
		requests_1: () => Promise.resolve(),
		getHashes: () => ({}),
		updatedNoteCount: () => 0,
		failedDeleteCount: 0,
		convertedCount: 0
	}
	const data = createParsedSettings()
	const env: ScanEnvironment = {
		app: new App(),
		notices: { notify: (message) => notices.push(message) },
		loadState: () => state,
		commitScanResults: (media, hashes) => committed.push({ media, hashes }),
		probeAnki: () => Promise.resolve({ status: 'ready', message: 'ok' }),
		isAutoLaunchEnabled: () => false,
		shouldConfirmSync: () => false,
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

describe('formatScanIssues', () => {
	it('is null for a clean scan', () => {
		expect(formatScanIssues([])).toBeNull()
	})

	it('lists the first few problems and counts the rest', () => {
		const issues: ScanIssue[] = [
			{ file: 'a.md', kind: 'add-note', error: 'duplicate' },
			{ file: '', kind: 'tag-list', error: 'boom' },
			{ file: 'c.md', kind: 'add-note', error: 'no deck' },
			{ file: 'd.md', kind: 'add-note', error: 'x' }
		]
		expect(formatScanIssues(issues)).toBe(
			'4 problem(s) during sync:\na.md: duplicate\nbatch: boom\nc.md: no deck\n...and 1 more (see console)'
		)
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
		h.fake.updatedNoteCount = () => 1
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

describe('sync summary with failures', () => {
	it('subtracts rejected adds, appends failed=N to the log line and notifies the problems', async () => {
		const h = makeHarness()
		const data: ParsedSettings = createParsedSettings()
		h.fake.files = [tfile('a.md')]
		h.fake.ownFiles = createManagerFiles(
			data,
			[],
			[
				{ deckName: 'Default', modelName: 'Basic' },
				{ deckName: 'Default', modelName: 'Basic' }
			]
		)
		h.fake.scanIssues = [{ file: 'a.md', kind: 'add-note', error: 'duplicate' }]
		await h.orchestrator.scanVault()
		expect(h.infos.some((line) => line.includes('added=1 updated=0 deleted=0 failed=1'))).toBe(true)
		expect(h.notices).toContain('1 problem(s) during sync:\na.md: duplicate')
	})
})

describe('progress UI', () => {
	it('feeds the env progress control to initialiseFiles and closes it afterwards', async () => {
		const close = vi.fn()
		const control: ScanControl = { isCancelled: () => false }
		const h = makeHarness({ createProgress: () => ({ control, close }) })
		const seen: ScanControl[] = []
		h.fake.initialiseFiles = (c) => {
			seen.push(c ?? {})
			return Promise.resolve()
		}
		await h.orchestrator.scanVault()
		expect(seen).toEqual([control])
		expect(close).toHaveBeenCalledTimes(1)
	})

	it('closes the progress UI and reports cancellation', async () => {
		const close = vi.fn()
		const h = makeHarness({ createProgress: () => ({ control: {}, close }) })
		h.fake.initialiseFiles = () => Promise.reject(new ScanCancelledError())
		await h.orchestrator.scanVault()
		expect(close).toHaveBeenCalledTimes(1)
		expect(h.notices).toContain('Scan cancelled.')
	})

	it('leaves an explicit caller control alone', async () => {
		const createProgress = vi.fn()
		const h = makeHarness({ createProgress })
		const mine: ScanControl = { onProgress: vi.fn() }
		const seen: ScanControl[] = []
		h.fake.initialiseFiles = (c) => {
			seen.push(c ?? {})
			return Promise.resolve()
		}
		await h.orchestrator.scanVault(undefined, mine)
		expect(createProgress).not.toHaveBeenCalled()
		expect(seen).toEqual([mine])
	})
})

describe('ScanReport', () => {
	it('reports a completed sync with real counts and issues', async () => {
		const h = makeHarness()
		const data: ParsedSettings = createParsedSettings()
		h.fake.files = [tfile('a.md'), tfile('b.md')]
		h.fake.ownFiles = createManagerFiles(
			data,
			[{ id: 5, fields: { Front: 'Q' }, tags: [] }],
			[{ deckName: 'Default', modelName: 'Basic' }]
		)
		h.fake.scanIssues = [{ file: 'a.md', kind: 'media', error: 'missing' }]
		h.fake.updatedNoteCount = () => 1
		h.fake.convertedCount = 2
		h.fake.orphanNoteIds = [8, 9]
		h.fake.failedDeleteCount = 1
		const report = await h.orchestrator.scanVault()
		expect(report).toMatchObject({
			outcome: 'completed',
			dryRun: false,
			filesChanged: 1,
			filesTotal: 2,
			added: 1,
			updated: 1,
			deleted: 1,
			converted: 2,
			issues: [{ file: 'a.md', kind: 'media', error: 'missing' }]
		})
	})

	it('counts notes deleted because their block was removed, not only DELETE lines', async () => {
		const h = makeHarness()
		const data: ParsedSettings = createParsedSettings()
		h.fake.files = [tfile('a.md')]
		h.fake.ownFiles = createManagerFiles(data, [], [{ deckName: 'Default', modelName: 'Basic' }])
		h.fake.orphanNoteIds = [11, 12]
		const report = await h.orchestrator.scanVault()
		expect(report.deleted).toBe(2)
		expect(h.infos.some((line) => line.includes('deleted=2'))).toBe(true)
	})

	it('reports nothing-to-sync with the total file count', async () => {
		const h = makeHarness()
		h.fake.files = [tfile('a.md')]
		const report = await h.orchestrator.scanVault()
		expect(report).toMatchObject({ outcome: 'nothing-to-sync', filesChanged: 0, filesTotal: 1 })
	})

	it('reports aborted with the probe message when Anki is not ready', async () => {
		const h = makeHarness({ probeAnki: () => Promise.resolve({ status: 'closed', message: 'Anki is closed.' }) })
		const report = await h.orchestrator.scanVault()
		expect(report).toMatchObject({ outcome: 'aborted', message: 'Anki is closed.' })
	})

	it('reports cancelled when the scan is cancelled', async () => {
		const h = makeHarness()
		h.fake.initialiseFiles = () => Promise.reject(new ScanCancelledError())
		const report = await h.orchestrator.scanVault()
		expect(report.outcome).toBe('cancelled')
	})

	it('reports busy for a concurrent scan or dry-run', async () => {
		const h = makeHarness()
		let release!: () => void
		h.fake.initialiseFiles = () => new Promise<void>((resolve) => (release = resolve))
		const first = h.orchestrator.scanVault()
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect((await h.orchestrator.scanVault()).outcome).toBe('busy')
		const dry = await h.orchestrator.runDryRun()
		expect(dry).toMatchObject({ outcome: 'busy', dryRun: true })
		release()
		await first
	})

	it('reports awaiting-confirmation when Confirm Before Sync owns the decision', async () => {
		const h = makeHarness({ shouldConfirmSync: () => true })
		const report = await h.orchestrator.scanVault()
		expect(report.outcome).toBe('awaiting-confirmation')
	})

	it('reports the would-be counts and details for a dry-run', async () => {
		const h = makeHarness()
		const data: ParsedSettings = createParsedSettings()
		h.fake.files = [tfile('a.md')]
		h.fake.ownFiles = createManagerFiles(data, [], [{ deckName: 'Default', modelName: 'Basic' }])
		const manager = h.fake as unknown as Record<string, unknown>
		manager['data'] = { allow_note_type_changes: false }
		manager['orphanNoteIds'] = []
		manager['orphanFileById'] = () => new Map<number, string>()
		const report = await h.orchestrator.runDryRun()
		expect(report).toMatchObject({ outcome: 'completed', dryRun: true, added: 1, updated: 0, deleted: 0 })
		expect(report.details?.changes.length).toBeGreaterThan(0)
	})

	it('includes the notes a dry-run found it cannot sync', async () => {
		const h = makeHarness()
		const data: ParsedSettings = createParsedSettings()
		h.fake.files = [tfile('a.md')]
		h.fake.ownFiles = createManagerFiles(data, [], [])
		const issue: ScanIssue = { file: 'a.md', kind: 'cloze-without-deletions', error: 'no deletions', line: 4 }
		h.fake.ownFiles[0].parseIssues = [issue]
		const manager = h.fake as unknown as Record<string, unknown>
		manager['data'] = { allow_note_type_changes: false }
		manager['orphanFileById'] = () => new Map<number, string>()

		const report = await h.orchestrator.runDryRun()

		expect(report.issues).toEqual([issue])
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
			{ isAutoLaunchEnabled: () => false, shouldConfirmSync: () => false }
		)
		expect(env.loadState()).toBe(state)
		expect(env.shouldConfirmSync()).toBe(false)
		expect(env.openPreviewModal).toBeUndefined()
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
			{ isAutoLaunchEnabled: () => false, shouldConfirmSync: () => false }
		)
		const probe = await env.probeAnki()
		expect(probe.status).toBe('ready')
		await expect(env.launchAnki(false)).resolves.toBe('skipped-disabled')
		const data = await env.toData(env.app, state.settings, {})
		expect(data.vault_name).toBe('test-vault')
		expect(data.EXISTING_IDS.size).toBe(0)
	})
})

/** One pending add, wired so the dry-run collector reads manager state. */
function armReadyChanges(h: { fake: FakeManager }): void {
	const data = createParsedSettings()
	h.fake.ownFiles = createManagerFiles(data, [], [{ deckName: 'Default', modelName: 'Basic' }])
	const manager = h.fake as unknown as Record<string, unknown>
	manager['data'] = { allow_note_type_changes: false }
	manager['orphanNoteIds'] = []
	manager['orphanFileById'] = () => new Map<number, string>()
}

function captureModal(): {
	calls: Array<{ summary: DryRunSummary; callbacks: PreviewCallbacks }>
	opener: (summary: DryRunSummary, callbacks: PreviewCallbacks) => void
} {
	const calls: Array<{ summary: DryRunSummary; callbacks: PreviewCallbacks }> = []
	return {
		calls,
		opener: (summary, callbacks) => {
			calls.push({ summary, callbacks })
		}
	}
}

async function tick(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0))
	await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('previewScan', () => {
	it('returns a ready preview with a commit that syncs on demand', async () => {
		const h = makeHarness()
		armReadyChanges(h)
		const requests = vi.fn()
		h.fake.requests_1 = requests

		const preview = await h.orchestrator.previewScan()
		expect(preview.status).toBe('ready')
		if (preview.status !== 'ready') {
			throw new Error('expected ready preview')
		}
		expect(preview.summary.wouldAdd).toBe(1)
		expect(requests).not.toHaveBeenCalled()
		expect(h.committed).toEqual([])

		await preview.commit()
		expect(requests).toHaveBeenCalledTimes(1)
		expect(h.committed).toHaveLength(1)
	})

	it('returns empty when nothing changed', async () => {
		const h = makeHarness()
		const preview = await h.orchestrator.previewScan()
		expect(preview).toEqual({ status: 'empty' })
	})

	it('returns aborted when Anki is not ready', async () => {
		const h = makeHarness({
			probeAnki: () => Promise.resolve({ status: 'needs-key', message: 'Set the API key.' })
		})
		const preview = await h.orchestrator.previewScan()
		expect(preview).toEqual({ status: 'aborted' })
		expect(h.createdWith).toEqual([])
	})

	it('propagates cancellation to the caller', async () => {
		const h = makeHarness()
		h.fake.initialiseFiles = () => Promise.reject(new ScanCancelledError())
		await expect(h.orchestrator.previewScan()).rejects.toBeInstanceOf(ScanCancelledError)
	})
})

describe('runPreviewSync', () => {
	it('shares the scan-in-progress guard', async () => {
		const h = makeHarness()
		let release!: () => void
		h.fake.initialiseFiles = () => new Promise<void>((resolve) => (release = resolve))
		const first = h.orchestrator.runPreviewSync()
		await tick()
		await h.orchestrator.runPreviewSync()
		expect(h.notices).toContain('A vault scan is already in progress.')
		release()
		await first
		expect(h.notices).toContain('No changed files found. Nothing to sync.')
	})

	it('reports empty plans without opening a modal', async () => {
		const modal = captureModal()
		const h = makeHarness({ openPreviewModal: modal.opener })
		await h.orchestrator.runPreviewSync()
		expect(h.notices).toContain('No changed files found. Nothing to sync.')
		expect(modal.calls).toEqual([])
	})

	it('falls back to the legacy notice preview without an opener', async () => {
		const h = makeHarness()
		armReadyChanges(h)
		const requests = vi.fn()
		h.fake.requests_1 = requests
		await h.orchestrator.runPreviewSync()
		expect(h.notices).toContain('Dry-run: +1 ~0 -0 convert 0 (nothing written, see console)')
		expect(requests).not.toHaveBeenCalled()
		expect(h.committed).toEqual([])
		// Guard released: a later scan proceeds.
		await h.orchestrator.runDryRun()
		expect(h.notices).toContain('Dry-run: +1 ~0 -0 convert 0 (nothing written, see console)')
	})

	it('syncs on confirm and releases the guard', async () => {
		const modal = captureModal()
		const h = makeHarness({ openPreviewModal: modal.opener })
		armReadyChanges(h)
		const requests = vi.fn()
		h.fake.requests_1 = requests

		const run = h.orchestrator.runPreviewSync()
		await tick()
		expect(modal.calls).toHaveLength(1)
		expect(modal.calls[0].summary.wouldAdd).toBe(1)
		expect(requests).not.toHaveBeenCalled()
		modal.calls[0].callbacks.onConfirm()
		await run

		expect(requests).toHaveBeenCalledTimes(1)
		expect(h.committed).toHaveLength(1)
		expect(h.notices).toContain('Scan complete: +1 ~0 -0 (1/0 files)')
		// Guard released after confirm.
		const second = h.orchestrator.runPreviewSync()
		await tick()
		expect(modal.calls).toHaveLength(2)
		modal.calls[1].callbacks.onCancel()
		await second
	})

	it('writes nothing on cancel and releases the guard', async () => {
		const modal = captureModal()
		const h = makeHarness({ openPreviewModal: modal.opener })
		armReadyChanges(h)
		const requests = vi.fn()
		h.fake.requests_1 = requests

		const run = h.orchestrator.runPreviewSync()
		await tick()
		modal.calls[0].callbacks.onCancel()
		await run

		expect(requests).not.toHaveBeenCalled()
		expect(h.committed).toEqual([])
		const second = h.orchestrator.runPreviewSync()
		await tick()
		expect(modal.calls).toHaveLength(2)
		modal.calls[1].callbacks.onCancel()
		await second
	})

	it('notices commit failures and releases the guard', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
		const modal = captureModal()
		const h = makeHarness({ openPreviewModal: modal.opener })
		armReadyChanges(h)
		h.fake.requests_1 = () => Promise.reject(new Error('anki down'))

		const run = h.orchestrator.runPreviewSync()
		await tick()
		modal.calls[0].callbacks.onConfirm()
		await run

		expect(h.notices).toContain('Sync failed. Check console for details.')
		expect(h.committed).toEqual([])
		const second = h.orchestrator.runPreviewSync()
		await tick()
		expect(modal.calls).toHaveLength(2)
		modal.calls[1].callbacks.onCancel()
		await second
	})

	it('reports cancellation without opening a modal', async () => {
		const modal = captureModal()
		const h = makeHarness({ openPreviewModal: modal.opener })
		h.fake.initialiseFiles = () => Promise.reject(new ScanCancelledError())
		await h.orchestrator.runPreviewSync()
		expect(h.notices).toContain('Scan cancelled.')
		expect(modal.calls).toEqual([])
	})
})

describe('scanVault confirm routing', () => {
	it('routes through the modal when Confirm Before Sync is on', async () => {
		const modal = captureModal()
		const h = makeHarness({ shouldConfirmSync: () => true, openPreviewModal: modal.opener })
		armReadyChanges(h)
		const requests = vi.fn()
		h.fake.requests_1 = requests

		const run = h.orchestrator.scanVault()
		await tick()
		expect(modal.calls).toHaveLength(1)
		expect(requests).not.toHaveBeenCalled()
		modal.calls[0].callbacks.onConfirm()
		await run
		expect(requests).toHaveBeenCalledTimes(1)
	})

	it('bypasses the modal for unattended scans even when the setting is on', async () => {
		const modal = captureModal()
		const h = makeHarness({ shouldConfirmSync: () => true, openPreviewModal: modal.opener })
		armReadyChanges(h)
		const requests = vi.fn()
		h.fake.requests_1 = requests

		await h.orchestrator.scanVault(undefined, {}, { bypassConfirm: true })
		expect(modal.calls).toEqual([])
		expect(requests).toHaveBeenCalledTimes(1)
	})

	it('scans directly when the setting is off', async () => {
		const modal = captureModal()
		const h = makeHarness({ shouldConfirmSync: () => false, openPreviewModal: modal.opener })
		armReadyChanges(h)
		const requests = vi.fn()
		h.fake.requests_1 = requests

		await h.orchestrator.scanVault()
		expect(modal.calls).toEqual([])
		expect(requests).toHaveBeenCalledTimes(1)
	})
})

describe('ScanOrchestrator.validate', () => {
	const clean = 'START\nBasic\nFront: q\nBack: a\nEND\n'

	it('checks unsaved text and reports Anki as unchecked when it is closed', async () => {
		const h = makeHarness({ probeAnki: async () => ({ status: 'closed', message: 'closed' }) })
		;(h.fake as unknown as Record<string, unknown>)['data'] = {
			...createParsedSettings(),
			loadExistingIds: async () => []
		}
		;(h.fake as unknown as Record<string, unknown>)['mediaExistsFrom'] = () => () => true
		const report = await h.orchestrator.validate({ inline: { path: 'draft.md', text: clean } })

		expect(report).toMatchObject({ filesChecked: 1, blocks: 1, errors: 0, ankiChecked: false })
	})

	it('reports an occlusion in unsaved text whose image is not in the vault', async () => {
		const h = makeHarness({ probeAnki: async () => ({ status: 'closed', message: 'closed' }) })
		const manager = h.fake as unknown as Record<string, unknown>
		manager['data'] = {
			...createParsedSettings({ fields_dict: { 'Image Occlusion': ['Occlusion', 'Image'] } }),
			loadExistingIds: async () => []
		}
		manager['mediaExistsFrom'] = () => () => false
		const text =
			'START\nImage Occlusion\nOcclusion: {{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.1}}\nImage: ![[a.png]]\nEND\n'

		const report = await h.orchestrator.validate({ inline: { path: 'draft.md', text } })

		expect(report.byKind).toEqual({ 'occlusion-image-missing': 1 })
		expect(report.errors).toBe(1)
	})

	it('reads every file a scan would see, changed or not', async () => {
		const h = makeHarness()
		const manager = h.fake as unknown as Record<string, unknown>
		manager['data'] = { ...createParsedSettings(), loadExistingIds: async () => [] }
		manager['validationInputs'] = async () => [
			{ path: 'a.md', text: clean, data: createParsedSettings() },
			{ path: 'b.md', text: clean, data: createParsedSettings() }
		]

		const report = await h.orchestrator.validate()

		expect(report.filesChecked).toBe(2)
		expect(report.ankiChecked).toBe(true)
	})

	it('stays useful when reading the note IDs fails', async () => {
		const h = makeHarness()
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		const manager = h.fake as unknown as Record<string, unknown>
		manager['data'] = {
			...createParsedSettings(),
			loadExistingIds: () => Promise.reject(new Error('offline'))
		}
		manager['validationInputs'] = async () => []

		expect((await h.orchestrator.validate()).ankiChecked).toBe(false)
	})
})

describe('ScanOrchestrator scan state', () => {
	it('says when a scan is running and remembers how the last one ended', async () => {
		const h = makeHarness()
		expect(h.orchestrator.lastReport).toBeUndefined()
		let release!: () => void
		h.fake.initialiseFiles = () => new Promise<void>((resolve) => (release = resolve))

		const scan = h.orchestrator.scanVault()
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(h.orchestrator.isScanning).toBe(true)
		release()
		const report = await scan

		expect(h.orchestrator.isScanning).toBe(false)
		expect(h.orchestrator.lastReport).toBe(report)
	})

	it('remembers a dry-run too, but not a refused concurrent call', async () => {
		const h = makeHarness()
		const report = await h.orchestrator.runDryRun()
		expect(h.orchestrator.lastReport).toBe(report)

		let release!: () => void
		h.fake.initialiseFiles = () => new Promise<void>((resolve) => (release = resolve))
		const first = h.orchestrator.scanVault()
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect((await h.orchestrator.scanVault()).outcome).toBe('busy')
		expect(h.orchestrator.lastReport).toBe(report)
		release()
		await first
	})
})
