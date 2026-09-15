import { describe, it, expect, vi, afterEach } from 'vitest'
import {
	LAUNCH_GRACE_MS,
	PROBE_TIMEOUT_MS,
	launchAnki,
	probeAnkiStatus,
	resolveAnkiLaunchTarget,
	type LaunchEnvironment
} from '../../src/anki-launch'

function testEnvironment(overrides: Partial<LaunchEnvironment> = {}): LaunchEnvironment {
	return {
		platform: 'darwin',
		env: {},
		pathExists: () => false,
		pathOnPath: () => false,
		...overrides
	}
}

describe('probeAnkiStatus classification', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('exposes its timeout and grace constants for tuning', () => {
		expect(PROBE_TIMEOUT_MS).toBeGreaterThan(0)
		expect(LAUNCH_GRACE_MS).toBeGreaterThan(0)
	})

	it('reports ready when permission is granted', async () => {
		const probe = await probeAnkiStatus(async () => ({ permission: 'granted', version: 6 }))
		expect(probe.status).toBe('ready')
		expect(probe.version).toBe(6)
	})

	it('reports needs-key when the daemon requires an API key', async () => {
		const probe = await probeAnkiStatus(async () => ({ permission: 'granted', requireApiKey: true, version: 6 }))
		expect(probe.status).toBe('needs-key')
	})

	it('reports denied-origin when permission is denied', async () => {
		const probe = await probeAnkiStatus(async () => ({ permission: 'denied' }))
		expect(probe.status).toBe('denied-origin')
	})

	it('reports closed on connection refusal', async () => {
		const refused = new Error('Failed to connect to Anki: fetch failed')
		const probe = await probeAnkiStatus(async () => {
			throw refused
		})
		expect(probe.status).toBe('closed')
		expect(probe.message).toMatch(/running/i)
	})

	it('reports busy-port on non-Anki HTTP responses', async () => {
		const probe = await probeAnkiStatus(async () => {
			throw new Error('Unexpected token <, "<!DOCTYPE "... is not valid JSON')
		})
		expect(probe.status).toBe('busy-port')
	})

	it('reports starting-or-busy when the request never settles', async () => {
		const hanging = new Promise<never>(() => {})
		const probe = await probeAnkiStatus(() => hanging, 5)
		expect(probe.status).toBe('starting-or-busy')
	})
})

describe('resolveAnkiLaunchTarget on three platforms', () => {
	it('uses open -a on macOS', () => {
		expect(resolveAnkiLaunchTarget(testEnvironment({ platform: 'darwin' }))).toEqual({
			command: 'open',
			args: ['-a', 'Anki']
		})
	})

	it('picks the first existing Windows install path', () => {
		const env = testEnvironment({
			platform: 'win32',
			env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
			pathExists: (path) => path === 'C:\\Users\\u\\AppData\\Local\\Programs\\Anki\\anki.exe'
		})
		expect(resolveAnkiLaunchTarget(env)).toEqual({
			command: 'C:\\Users\\u\\AppData\\Local\\Programs\\Anki\\anki.exe',
			args: []
		})
	})

	it('falls back across Windows roots and returns null when nothing exists', () => {
		const programFiles = testEnvironment({
			platform: 'win32',
			env: { PROGRAMFILES: 'C:\\Program Files' },
			pathExists: (path) => path === 'C:\\Program Files\\Anki\\anki.exe'
		})
		expect(resolveAnkiLaunchTarget(programFiles)?.command).toBe('C:\\Program Files\\Anki\\anki.exe')
		expect(resolveAnkiLaunchTarget(testEnvironment({ platform: 'win32', env: {} }))).toBeNull()
	})

	it('prefers PATH binary on Linux, then flatpak', () => {
		expect(resolveAnkiLaunchTarget(testEnvironment({ platform: 'linux', pathOnPath: () => true }))).toEqual({
			command: 'anki',
			args: []
		})
		expect(resolveAnkiLaunchTarget(testEnvironment({ platform: 'linux', pathOnPath: () => false }))).toEqual({
			command: 'flatpak',
			args: ['run', 'net.ankiweb.Anki']
		})
	})

	it('returns null on unknown platforms', () => {
		expect(resolveAnkiLaunchTarget(testEnvironment({ platform: 'other' as NodeJS.Platform }))).toBeNull()
	})
})

describe('launchAnki fail-fast behavior', () => {
	it('skips everything when auto-launch is disabled', async () => {
		const spawner = { spawn: vi.fn(() => ({ unref: () => {} })) }
		expect(await launchAnki(false, { spawner })).toBe('skipped-disabled')
		expect(spawner.spawn).not.toHaveBeenCalled()
	})

	it('returns no-target when no launch strategy exists', async () => {
		const spawner = { spawn: vi.fn(() => ({ unref: () => {} })) }
		const environment = testEnvironment({ platform: 'other' as NodeJS.Platform })
		expect(await launchAnki(true, { environment, spawner })).toBe('no-target')
		expect(spawner.spawn).not.toHaveBeenCalled()
	})

	it('spawns detached and reports ready after one re-probe', async () => {
		const unref = vi.fn()
		const spawner = { spawn: vi.fn(() => ({ unref })) }
		const waitMs = vi.fn(async () => {})
		const probe = vi.fn(async () => ({ status: 'ready' as const, message: 'ok' }))

		const outcome = await launchAnki(true, {
			environment: testEnvironment(),
			spawner,
			waitMs,
			probe
		})

		expect(outcome).toBe('launched-and-ready')
		expect(spawner.spawn).toHaveBeenCalledWith('open', ['-a', 'Anki'], {
			detached: true,
			stdio: 'ignore',
			windowsHide: true
		})
		expect(unref).toHaveBeenCalled()
		expect(waitMs).toHaveBeenCalledTimes(1)
		expect(probe).toHaveBeenCalledTimes(1)
	})

	it('reports pending when the single re-probe still finds Anki down', async () => {
		const spawner = { spawn: vi.fn(() => ({ unref: () => {} })) }
		const outcome = await launchAnki(true, {
			environment: testEnvironment(),
			spawner,
			waitMs: async () => {},
			probe: async () => ({ status: 'closed' as const, message: 'down' })
		})
		expect(outcome).toBe('launched-pending')
	})
})
