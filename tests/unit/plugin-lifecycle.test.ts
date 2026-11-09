import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import MyPlugin, { getActiveMarkdownFile } from '../../main.ts'
import * as AnkiConnect from '../../src/anki'
import type { StoredPluginData } from '../../src/interfaces/settings-interface'
import type { ApiHandlers } from '../../src/api-server'
import type { ScanReport } from '../../src/scan-orchestrator'
import { TFile, TFolder, clearNotices, createdNotices } from 'obsidian'

function makePlugin(): MyPlugin {
	const plugin = new MyPlugin({} as never, {} as never)
	vi.spyOn(plugin, 'saveData').mockResolvedValue(undefined)
	return plugin
}

describe('loadSettings', () => {
	it('keeps stored settings even when an auxiliary data.json key is missing', async () => {
		AnkiConnect.setTransport({ invoke: async () => [] })
		const plugin = makePlugin()
		const defaults = await plugin.getDefaultSettings()
		const stored = { settings: defaults } as unknown as StoredPluginData
		const loaded = await plugin.loadSettings(stored)
		expect(loaded.Defaults.Deck).toBe(defaults.Defaults.Deck)
		expect(plugin.saveData).not.toHaveBeenCalledWith(expect.objectContaining({ 'Added Media': [] }))
	})
})

describe('loadFieldsDict', () => {
	it('tolerates a snapshot without fields_dict', async () => {
		const plugin = makePlugin()
		const stored = { settings: {} } as unknown as StoredPluginData
		await expect(plugin.loadFieldsDict(stored)).resolves.toEqual({})
	})
})

describe('startSchedule', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.stubGlobal('window', globalThis)
	})
	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	function withInterval(minutes: number): MyPlugin {
		const plugin = makePlugin()
		plugin.settings = { Defaults: { 'Scheduling Interval': minutes } } as never
		vi.spyOn(plugin, 'registerInterval').mockImplementation((id: number) => id)
		return plugin
	}

	it('does nothing when the interval is 0', () => {
		const plugin = withInterval(0)
		plugin.startSchedule()
		expect(plugin.schedule_id).toBeUndefined()
		expect(plugin.registerInterval).not.toHaveBeenCalled()
	})

	it('scans on the configured cadence and replaces the previous timer', async () => {
		const plugin = withInterval(5)
		const scan = vi.spyOn(plugin, 'scanVault').mockResolvedValue(undefined)
		plugin.startSchedule()
		const first = plugin.schedule_id
		plugin.startSchedule()
		expect(plugin.schedule_id).not.toBe(first)
		await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
		expect(scan).toHaveBeenCalledTimes(1)
	})

	it('stops the timer when the interval is set back to 0', async () => {
		const plugin = withInterval(5)
		const scan = vi.spyOn(plugin, 'scanVault').mockResolvedValue(undefined)
		plugin.startSchedule()
		plugin.settings.Defaults['Scheduling Interval'] = 0
		plugin.startSchedule()
		await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
		expect(scan).not.toHaveBeenCalled()
		expect(plugin.schedule_id).toBeUndefined()
	})
})

describe('Local API scan handlers', () => {
	function file(path: string): TFile {
		const tfile = new TFile()
		tfile.path = path
		tfile.extension = path.slice(path.lastIndexOf('.') + 1)
		return tfile
	}

	function folder(path: string, children: Array<TFile | TFolder>): TFolder {
		const tfolder = new TFolder()
		tfolder.path = path
		tfolder.children = children
		return tfolder
	}

	function pluginWith(entries: Array<TFile | TFolder>) {
		const plugin = makePlugin()
		const byPath = new Map(entries.map((entry) => [entry.path, entry]))
		plugin.app.vault.getAbstractFileByPath = (path: string) => byPath.get(path) ?? null
		const scanVault = vi.spyOn(plugin, 'scanVault').mockResolvedValue({ outcome: 'completed' } as ScanReport)
		const handlers = (plugin as unknown as { apiHandlers(): ApiHandlers }).apiHandlers()
		return { handlers, scanVault }
	}

	it('scans the Markdown files of a folder and its subfolders', async () => {
		const a = file('Cardio/a.md')
		const b = file('Cardio/Valves/b.md')
		const image = file('Cardio/heart.png')
		const cardio = folder('Cardio', [a, image, folder('Cardio/Valves', [b])])
		const { handlers, scanVault } = pluginWith([cardio, a])

		expect(await handlers.scanFolder('Cardio')).toEqual({ outcome: 'completed' })
		expect(scanVault).toHaveBeenCalledWith([a, b])
	})

	it('finds a folder named in the other Unicode form', async () => {
		const notes = folder('Clínica'.normalize('NFC'), [])
		const { handlers, scanVault } = pluginWith([notes])

		await handlers.scanFolder('Clínica'.normalize('NFD'))

		expect(scanVault).toHaveBeenCalledWith([])
	})

	it('answers null for a path that is not a folder', async () => {
		const a = file('a.md')
		const { handlers, scanVault } = pluginWith([a])

		expect(await handlers.scanFolder('a.md')).toBeNull()
		expect(await handlers.scanFolder('nowhere')).toBeNull()
		expect(scanVault).not.toHaveBeenCalled()
	})

	it('scans several files in one scan', async () => {
		const a = file('a.md')
		const b = file('Notes/b.md')
		const { handlers, scanVault } = pluginWith([a, b])

		await handlers.scanFiles(['a.md', 'Notes/b.md'])

		expect(scanVault).toHaveBeenCalledTimes(1)
		expect(scanVault).toHaveBeenCalledWith([a, b])
	})

	it('names the paths that are not Markdown files and scans nothing', async () => {
		const a = file('a.md')
		const image = file('heart.png')
		const { handlers, scanVault } = pluginWith([a, image, folder('Notes', [])])

		expect(await handlers.scanFiles(['a.md', 'heart.png', 'gone.md', 'Notes'])).toEqual({
			missing: ['heart.png', 'gone.md', 'Notes']
		})
		expect(scanVault).not.toHaveBeenCalled()
	})
})

describe('onExternalSettingsChange', () => {
	async function loaded() {
		AnkiConnect.setTransport({ invoke: async () => [] })
		const plugin = makePlugin()
		plugin.settings = await plugin.getDefaultSettings()
		plugin.settings.Defaults['Scheduling Interval'] = 5
		plugin.file_hashes = { 'a.md': { hash: 'h', mtime: 1, size: 1, noteIds: [1] } }
		plugin.media_records = { 'img.png': { hash: 'x' } } as never
		plugin.added_media = ['img.png']
		const startSchedule = vi.spyOn(plugin, 'startSchedule').mockImplementation(() => undefined)
		const restartApiServer = vi.spyOn(plugin, 'restartApiServer').mockResolvedValue(undefined)
		return { plugin, startSchedule, restartApiServer }
	}

	function onDisk(plugin: MyPlugin, change: (stored: StoredPluginData) => void): StoredPluginData {
		const stored = JSON.parse(
			JSON.stringify({
				settings: plugin.settings,
				fields_dict: { Basic: ['Front', 'Back'] },
				'File Hashes': {},
				'Media Records': {},
				'Added Media': []
			})
		) as StoredPluginData
		change(stored)
		vi.spyOn(plugin, 'loadData').mockResolvedValue(stored)
		return stored
	}

	it('applies the settings from the file and keeps the scan state in memory', async () => {
		const { plugin, startSchedule, restartApiServer } = await loaded()
		const hashes = plugin.file_hashes
		onDisk(plugin, (stored) => {
			stored.settings.Defaults.Deck = 'Synced'
			stored.settings.CUSTOM_REGEXPS = { Basic: '', Cloze: '' }
		})

		await plugin.onExternalSettingsChange()

		expect(plugin.settings.Defaults.Deck).toBe('Synced')
		expect(plugin.note_types).toEqual(['Basic', 'Cloze'])
		expect(plugin.fields_dict).toEqual({ Basic: ['Front', 'Back'] })
		expect(plugin.file_hashes).toBe(hashes)
		expect(plugin.file_hashes['a.md']?.noteIds).toEqual([1])
		expect(plugin.added_media).toEqual(['img.png'])
		expect(plugin.media_records).toEqual({ 'img.png': { hash: 'x' } })
		expect(startSchedule).not.toHaveBeenCalled()
		expect(restartApiServer).not.toHaveBeenCalled()
		expect(plugin.saveData).not.toHaveBeenCalled()
	})

	it('restarts the schedule when its interval changed', async () => {
		const { plugin, startSchedule, restartApiServer } = await loaded()
		onDisk(plugin, (stored) => {
			stored.settings.Defaults['Scheduling Interval'] = 10
		})

		await plugin.onExternalSettingsChange()

		expect(startSchedule).toHaveBeenCalledOnce()
		expect(restartApiServer).not.toHaveBeenCalled()
	})

	it.each([
		['Local API', true],
		['Local API Port', 28000],
		['Local API Token', 'another-token-of-enough-length-000']
	] as const)('restarts the local API when %s changed', async (key, value) => {
		const { plugin, startSchedule, restartApiServer } = await loaded()
		onDisk(plugin, (stored) => {
			;(stored.settings.Defaults as Record<string, unknown>)[key] = value
		})

		await plugin.onExternalSettingsChange()

		expect(restartApiServer).toHaveBeenCalledOnce()
		expect(startSchedule).not.toHaveBeenCalled()
	})

	it('keeps the fields dictionary when the file has none', async () => {
		const { plugin } = await loaded()
		plugin.fields_dict = { Cloze: ['Text', 'Extra'] }
		onDisk(plugin, (stored) => {
			delete (stored as Partial<StoredPluginData>).fields_dict
		})

		await plugin.onExternalSettingsChange()

		expect(plugin.fields_dict).toEqual({ Cloze: ['Text', 'Extra'] })
	})

	it.each([null, {}, { settings: null }])('ignores a file without settings: %j', async (stored) => {
		const { plugin, startSchedule, restartApiServer } = await loaded()
		const settings = plugin.settings
		vi.spyOn(plugin, 'loadData').mockResolvedValue(stored)

		await plugin.onExternalSettingsChange()

		expect(plugin.settings).toBe(settings)
		expect(plugin.file_hashes['a.md']?.noteIds).toEqual([1])
		expect(startSchedule).not.toHaveBeenCalled()
		expect(restartApiServer).not.toHaveBeenCalled()
	})

	it('migrates settings written by an older version', async () => {
		const { plugin } = await loaded()
		onDisk(plugin, (stored) => {
			delete (stored.settings.Defaults as Partial<Record<string, unknown>>)['Confirm Before Sync']
		})

		await plugin.onExternalSettingsChange()

		expect(plugin.settings.Defaults['Confirm Before Sync']).toBe(false)
	})
})

describe('getActiveMarkdownFile', () => {
	beforeEach(() => {
		clearNotices()
	})

	it('returns null and notifies when no file is active', () => {
		expect(getActiveMarkdownFile(null)).toBeNull()
		expect(createdNotices).toContain('No active Markdown file to scan.')
	})

	it('returns null and notifies when active file is not markdown', () => {
		const canvas = new TFile()
		canvas.extension = 'canvas'
		expect(getActiveMarkdownFile(canvas)).toBeNull()
		expect(createdNotices).toContain('No active Markdown file to scan.')
	})

	it('returns the file and does not notify when active file is markdown', () => {
		const md = new TFile()
		md.extension = 'md'
		expect(getActiveMarkdownFile(md)).toBe(md)
		expect(createdNotices).not.toContain('No active Markdown file to scan.')
	})
})
