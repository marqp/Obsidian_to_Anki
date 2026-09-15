import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BuiltSide, ParitySide } from './parity-harness'

export type BenchSide = ParitySide

export interface BenchPhaseTimings {
	setupScan: number
	scanNotes: number
	scanInlineNotes: number
	search: number
	writeIDs: number
	total: number
}

export interface BenchRepResult {
	side: BenchSide
	scenario: string
	rep: number
	phases: BenchPhaseTimings
	cpuUserUs: number
	cpuSystemUs: number
	heapDelta: number
	rssPeak: number
	adds: number
	edits: number
	deletes: number
	inserts: number
}

interface BundleAllFile {
	setupScan(): void
	scanNotes(): void
	scanInlineNotes(): void
	search?: (noteType: string, regexp: string) => void
	custom_regexps?: Record<string, string>
	notes_to_add: unknown[]
	inline_notes_to_add: unknown[]
	regex_notes_to_add: unknown[]
	notes_to_edit: Array<{ identifier: number | null }>
	notes_to_delete: number[]
	note_ids: Array<number | null>
	writeIDs(): void
	scanDeletions(): void
}

interface BuiltSides {
	fork: BuiltSide
	upstream: BuiltSide
}

interface BenchFileData {
	EXISTING_IDS: Set<number> | number[]
	custom_regexps?: Record<string, string>
}

function nowNs(): bigint {
	return process.hrtime.bigint()
}

function nsToMs(ns: bigint): number {
	return Number(ns) / 1e6
}

function forceGc(): void {
	if (typeof global.gc === 'function') {
		global.gc()
	}
}

async function silenceWarningsAsync<T>(fn: () => Promise<T>): Promise<T> {
	const originalWarn = console.warn
	const originalError = console.error
	console.warn = () => undefined
	console.error = () => undefined
	try {
		return await fn()
	} finally {
		console.warn = originalWarn
		console.error = originalError
	}
}

async function loadBundle(entry: string): Promise<{
	AllFile: new (contents: string, path: string, url: string, data: unknown, cache: unknown) => BundleAllFile
}> {
	return (await import(pathToFileURL(entry).href)) as {
		AllFile: new (contents: string, path: string, url: string, data: unknown, cache: unknown) => BundleAllFile
	}
}

/**
 * External (non-invasive) measurement: drives the same public AllFile calls
 * the parity harness uses (setupScan/scanNotes/scanInlineNotes/search/
 * scanDeletions/writeIDs) and times each phase with hrtime. No console.log
 * is injected into either engine bundle; the optional --verbose flag only
 * controls the runner's own per-rep log lines.
 */
export async function timeOneRep(
	built: BuiltSides,
	helpersPath: string,
	side: BenchSide,
	files: Array<{ path: string; content: string }>,
	existingIds: number[],
	customRegexps: Record<string, string> | undefined,
	idSeed: number,
	verbose: boolean,
	scenario: string,
	rep: number
): Promise<BenchRepResult> {
	const bundle = await loadBundle(built[side].entry)
	const settingsModule = (await import(pathToFileURL(helpersPath).href)) as {
		buildParityFileData: (ids: number[], custom?: Record<string, string>) => Promise<BenchFileData>
	}
	const heapBefore = process.memoryUsage().heapUsed
	const cpuBefore = process.cpuUsage()
	const phases: BenchPhaseTimings = {
		setupScan: 0,
		scanNotes: 0,
		scanInlineNotes: 0,
		search: 0,
		writeIDs: 0,
		total: 0
	}
	let adds = 0
	let edits = 0
	let deletes = 0
	let inserts = 0
	let nextId = idSeed
	const tMeasured0 = nowNs()
	await silenceWarningsAsync(async () => {
		for (const { path: filePath, content } of files) {
			const data = await settingsModule.buildParityFileData(existingIds, customRegexps)
			const file = new bundle.AllFile(content, filePath, '', data, {})
			let t = nowNs()
			file.setupScan()
			phases.setupScan += nsToMs(nowNs() - t)
			t = nowNs()
			file.scanNotes()
			phases.scanNotes += nsToMs(nowNs() - t)
			t = nowNs()
			file.scanInlineNotes()
			phases.scanInlineNotes += nsToMs(nowNs() - t)
			t = nowNs()
			const regexps = file.custom_regexps ?? {}
			for (const noteType of Object.keys(regexps)) {
				const regexp = regexps[noteType]
				if (regexp && typeof file.search === 'function') {
					file.search(noteType, regexp)
				}
			}
			phases.search += nsToMs(nowNs() - t)
			adds += file.notes_to_add.length + file.inline_notes_to_add.length + file.regex_notes_to_add.length
			edits += file.notes_to_edit.filter((e) => e.identifier != null).length
			file.scanDeletions()
			deletes += file.notes_to_delete.length
			const fileAdds = file.notes_to_add.length + file.inline_notes_to_add.length + file.regex_notes_to_add.length
			const newIds = Array.from({ length: fileAdds }, () => nextId++)
			file.note_ids = [...newIds]
			t = nowNs()
			file.writeIDs()
			phases.writeIDs += nsToMs(nowNs() - t)
			inserts += newIds.length
		}
	})
	phases.total = nsToMs(nowNs() - tMeasured0)
	const cpuDiff = process.cpuUsage(cpuBefore)
	const memAfter = process.memoryUsage()
	if (verbose) {
		console.log(
			`[BENCH] scenario=${scenario} side=${side} rep=${rep} ` +
				`total=${phases.total.toFixed(3)}ms setup=${phases.setupScan.toFixed(3)}ms ` +
				`notes=${phases.scanNotes.toFixed(3)}ms inline=${phases.scanInlineNotes.toFixed(3)}ms ` +
				`writeIDs=${phases.writeIDs.toFixed(3)}ms adds=${adds} edits=${edits}`
		)
	}
	forceGc()
	return {
		side,
		scenario,
		rep,
		phases,
		cpuUserUs: cpuDiff.user,
		cpuSystemUs: cpuDiff.system,
		heapDelta: memAfter.heapUsed - heapBefore,
		rssPeak: memAfter.rss,
		adds,
		edits,
		deletes,
		inserts
	}
}

export interface BenchMatrixScenario {
	name: string
	files: Array<{ path: string; content: string }>
	existingIds: number[]
	customRegexps?: Record<string, string>
	reps: number
	warmup: number
}

export async function runBenchMatrix(options: {
	built: BuiltSides
	sourceRoots: Record<BenchSide, string>
	scenarios: BenchMatrixScenario[]
	idSeed: number
	verbose: boolean
}): Promise<BenchRepResult[]> {
	const results: BenchRepResult[] = []
	for (const scenario of options.scenarios) {
		if (options.verbose) {
			console.log(`[BENCH] warmup scenario=${scenario.name}`)
		}
		for (let w = 0; w < scenario.warmup; w++) {
			for (const side of ['fork', 'upstream'] as const) {
				await timeOneRep(
					options.built,
					path.join(options.sourceRoots[side], 'tests/parity/.helpers.mjs'),
					side,
					scenario.files,
					scenario.existingIds,
					scenario.customRegexps,
					options.idSeed,
					false,
					scenario.name,
					-1
				)
			}
		}
		// Interleaved A/B/A/B ordering so machine drift cannot favor one side.
		for (let rep = 0; rep < scenario.reps; rep++) {
			const order: BenchSide[] = rep % 2 === 0 ? ['fork', 'upstream'] : ['upstream', 'fork']
			for (const side of order) {
				forceGc()
				const result = await timeOneRep(
					options.built,
					path.join(options.sourceRoots[side], 'tests/parity/.helpers.mjs'),
					side,
					scenario.files,
					scenario.existingIds,
					scenario.customRegexps,
					options.idSeed,
					options.verbose,
					scenario.name,
					rep
				)
				results.push(result)
			}
		}
		if (options.verbose) {
			console.log(`[BENCH] done scenario=${scenario.name} reps=${scenario.reps}`)
		}
	}
	return results
}

export function writeBenchResults(repoRoot: string, results: BenchRepResult[]): string {
	const outPath = path.join(repoRoot, 'tests/parity/.bench-results.json')
	fs.writeFileSync(outPath, JSON.stringify({ results }, null, 2))
	return outPath
}
