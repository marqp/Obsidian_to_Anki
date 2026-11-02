import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import MyPlugin from '../../main.ts'
import * as AnkiConnect from '../../src/anki'
import type { StoredPluginData } from '../../src/interfaces/settings-interface'

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
