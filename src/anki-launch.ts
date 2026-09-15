import { existsSync } from 'fs'
import { spawn, type ChildProcess } from 'child_process'
import * as AnkiConnect from './anki'

/** Machine-readable classification of the AnkiConnect endpoint state. */
export type AnkiStatus = 'ready' | 'needs-key' | 'denied-origin' | 'closed' | 'starting-or-busy' | 'busy-port'

export interface AnkiProbe {
	status: AnkiStatus
	/** Human-readable, actionable message for Notices. */
	message: string
	/** Present when the daemon answered requestPermission. */
	version?: number
}

export interface LaunchTarget {
	command: string
	args: string[]
}

export interface LaunchEnvironment {
	platform: NodeJS.Platform
	env: Record<string, string | undefined>
	pathExists: (path: string) => boolean
	pathOnPath: (binary: string) => boolean
}

export interface Spawner {
	spawn: (command: string, args: string[], options: object) => { unref: () => void } | ChildProcess
}

const realEnvironment: LaunchEnvironment = {
	platform: process.platform,
	env: process.env as Record<string, string | undefined>,
	pathExists: existsSync,
	pathOnPath: () => true
}

const realSpawner: Spawner = {
	spawn: (command, args, options) => spawn(command, args, options as never)
}

/** How long to wait for requestPermission before calling the endpoint busy. */
export const PROBE_TIMEOUT_MS = 4000
/** Grace period after fire-and-forget launch before the single re-probe. */
export const LAUNCH_GRACE_MS = 2000

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(onTimeout()), ms)
	})
	return Promise.race([promise, timeout]).finally(() => {
		if (timer !== undefined) {
			clearTimeout(timer)
		}
	})
}

/**
 * Classify the AnkiConnect endpoint without side effects. Never throws:
 * every failure mode maps to a status with an actionable message.
 */
export async function probeAnkiStatus(
	invokeFn: typeof AnkiConnect.invoke = AnkiConnect.invoke,
	timeoutMs = PROBE_TIMEOUT_MS
): Promise<AnkiProbe> {
	type ProbeResult = AnkiConnect.PermissionResult | { probeError: unknown } | { timedOut: true }

	const probeCall = invokeFn('requestPermission').then(
		(value) => value as AnkiConnect.PermissionResult,
		(error: unknown): { probeError: unknown } => ({ probeError: error })
	)
	const result: ProbeResult = await withTimeout<ProbeResult>(probeCall, timeoutMs, () => ({ timedOut: true }))
	if (typeof result === 'object' && result !== null && 'timedOut' in result) {
		return {
			status: 'starting-or-busy',
			message: 'Anki is not answering yet — it may still be starting. Try the scan again in a few seconds.'
		}
	}
	if (typeof result === 'object' && result !== null && 'probeError' in result) {
		return classifyProbeError((result as { probeError: unknown }).probeError)
	}
	const permission = result as AnkiConnect.PermissionResult
	if (permission.permission === 'granted') {
		if (AnkiConnect.requiresApiKey(permission)) {
			return {
				status: 'needs-key',
				message: 'AnkiConnect requires an API key. Set it in the plugin settings (Anki API Key).',
				version: permission.version
			}
		}
		return {
			status: 'ready',
			message: `Connected to AnkiConnect (version ${permission.version ?? 'unknown'}).`,
			version: permission.version
		}
	}
	return {
		status: 'denied-origin',
		message: 'Anki denied permission. Check the AnkiConnect webCorsOriginList.'
	}
}

function classifyProbeError(error: unknown): AnkiProbe {
	const message = error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : String(error)
	if (/ECONNREFUSED|Failed to connect|fetch failed|Load failed|NetworkError/i.test(message)) {
		return {
			status: 'closed',
			message: 'Anki does not seem to be running. Open Anki (or enable Auto-launch Anki) and run the scan again.'
		}
	}
	if (/unexpected|<!DOCTYPE|<html|not valid JSON|JSON/i.test(message)) {
		return {
			status: 'busy-port',
			message: 'Port 8765 answered, but it is not AnkiConnect. Check what else is listening on 127.0.0.1:8765.'
		}
	}
	return {
		status: 'starting-or-busy',
		message: 'Anki is not answering yet — it may still be starting. Try the scan again in a few seconds.'
	}
}

/**
 * Resolve how to launch Anki Desktop on this machine. Pure function of
 * platform + environment, so every branch is unit-testable without spawning.
 * Returns null when no launch strategy is known (mobile, unknown platform).
 */
export function resolveAnkiLaunchTarget(environment: LaunchEnvironment = realEnvironment): LaunchTarget | null {
	if (environment.platform === 'darwin') {
		return { command: 'open', args: ['-a', 'Anki'] }
	}
	if (environment.platform === 'win32') {
		const candidates = [
			joinWindowsPath(environment.env['LOCALAPPDATA'], 'Programs\\Anki\\anki.exe'),
			joinWindowsPath(environment.env['PROGRAMFILES'], 'Anki\\anki.exe'),
			joinWindowsPath(environment.env['PROGRAMFILES(X86)'], 'Anki\\anki.exe')
		]
		for (const candidate of candidates) {
			if (candidate && environment.pathExists(candidate)) {
				return { command: candidate, args: [] }
			}
		}
		return null
	}
	if (environment.platform === 'linux') {
		if (environment.pathOnPath('anki')) {
			return { command: 'anki', args: [] }
		}
		return { command: 'flatpak', args: ['run', 'net.ankiweb.Anki'] }
	}
	return null
}

function joinWindowsPath(base: string | undefined, rest: string): string | null {
	if (!base) {
		return null
	}
	return `${base.replace(/[\\/]+$/, '')}\\${rest}`
}

export type LaunchOutcome = 'launched-and-ready' | 'launched-pending' | 'skipped-disabled' | 'no-target'

/**
 * Fire-and-forget Anki launch with a single re-probe (fail-fast: no polling
 * loops, no persistent UI). Returns whether the daemon is up afterwards.
 */
export async function launchAnki(
	autoLaunchEnabled: boolean,
	options: {
		environment?: LaunchEnvironment
		spawner?: Spawner
		waitMs?: (ms: number) => Promise<void>
		probe?: () => Promise<AnkiProbe>
	} = {}
): Promise<LaunchOutcome> {
	if (!autoLaunchEnabled) {
		return 'skipped-disabled'
	}
	const target = resolveAnkiLaunchTarget(options.environment)
	if (!target) {
		return 'no-target'
	}
	const spawner = options.spawner ?? realSpawner
	spawner.spawn(target.command, target.args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
	const wait = options.waitMs ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
	await wait(LAUNCH_GRACE_MS)
	const probe = options.probe ?? (() => probeAnkiStatus())
	const status = await probe()
	return status.status === 'ready' || status.status === 'needs-key' ? 'launched-and-ready' : 'launched-pending'
}
