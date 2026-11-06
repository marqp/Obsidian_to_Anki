import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import MyPlugin from '../../main.ts'
import * as AnkiConnect from '../../src/anki'
import type { StoredPluginData } from '../../src/interfaces/settings-interface'
import type { ApiHandlers } from '../../src/api-server'
import type { ScanReport } from '../../src/scan-orchestrator'
import { TFile, TFolder } from 'obsidian'

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
