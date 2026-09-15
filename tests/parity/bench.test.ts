import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { buildSides, cleanBuiltSides, createParityHarness } from './parity-harness'
import { runBenchMatrix, writeBenchResults, type BenchRepResult } from './bench-harness'
import { loadBenchScenarios } from './bench-scenarios'
import { buildScenarioReport, renderBenchReport } from './bench-report'
import config from './config.json'

const REPO_ROOT = path.resolve(__dirname, '../..')
const UPSTREAM_WORKTREE = process.env.PARITY_UPSTREAM_WORKTREE ?? '/tmp/parity-upstream'
const VERBOSE = process.argv.includes('--verbose')
const RESULTS_PATH = path.join(REPO_ROOT, 'tests/parity/.bench-results.json')

describe('bench: fork vs upstream engine speed', () => {
	let built: Awaited<ReturnType<typeof buildSides>> | null = null
	let results: BenchRepResult[] = []

	beforeAll(async () => {
		const { execFile } = await import('node:child_process')
		const run = (args: string[]): Promise<void> =>
			new Promise((resolve, reject) => {
				execFile(process.execPath, args, { cwd: REPO_ROOT }, (error, stdout, stderr) => {
					if (error) {
						reject(new Error(`${args.join(' ')}\n${stdout}\n${stderr}`.slice(0, 2000)))
					} else {
						resolve()
					}
				})
			})
		await run(['tests/parity/build-helpers.mjs', 'fork', REPO_ROOT, 'tests/parity/.helpers.mjs'])
		await run(['tests/parity/build-helpers.mjs', 'upstream', UPSTREAM_WORKTREE, 'tests/parity/.helpers.mjs'])
		built = await buildSides(REPO_ROOT, UPSTREAM_WORKTREE)
	}, 180000)

	afterAll(async () => {
		if (built) {
			await cleanBuiltSides(built)
		}
		await fs.promises.rm(path.join(REPO_ROOT, 'tests/parity/.helpers.mjs'), { force: true })
	})

	it('measures every scenario on both sides with a functional sanity gate', async () => {
		if (!built) {
			throw new Error('bench bundles were not built')
		}
		const scenarios = await loadBenchScenarios(REPO_ROOT)
		results = await runBenchMatrix({
			built,
			sourceRoots: { fork: REPO_ROOT, upstream: UPSTREAM_WORKTREE },
			scenarios,
			idSeed: config.idSeed,
			verbose: VERBOSE
		})
		// Sanity gate: identical functional output per scenario/rep/side.
		// Any divergence aborts the report instead of publishing numbers.
		const mismatches: string[] = []
		for (const scenario of scenarios) {
			const reps = results.filter((r) => r.scenario === scenario.name)
			const ref = reps.find((r) => r.side === 'fork' && r.rep === 0)
			for (const r of reps) {
				if (
					!ref ||
					r.adds !== ref.adds ||
					r.edits !== ref.edits ||
					r.deletes !== ref.deletes ||
					r.inserts !== ref.inserts
				) {
					mismatches.push(`${scenario.name}/${r.side}/rep${r.rep}`)
				}
			}
		}
		if (mismatches.length > 0) {
			console.log(`bench sanity mismatches: ${mismatches.join(', ')}`)
		}
		expect(mismatches).toEqual([])
		writeBenchResults(REPO_ROOT, results)
	}, 600000)

	it('emits the full Markdown report', async () => {
		let loaded: BenchRepResult[] = results
		if (loaded.length === 0) {
			const raw = await fs.promises.readFile(RESULTS_PATH, 'utf8')
			loaded = (JSON.parse(raw) as { results: BenchRepResult[] }).results
		}
		expect(loaded.length).toBeGreaterThan(0)
		const scenarios = await loadBenchScenarios(REPO_ROOT)
		const reports = scenarios.map((s) =>
			buildScenarioReport(
				s.name,
				loaded.filter((r) => r.scenario === s.name)
			)
		)
		// Cross-check against the parity harness canonical output on one
		// scenario: both paths must agree on adds/edits for identical input.
		if (built) {
			const harness = createParityHarness({ existingIds: [], idSeed: config.idSeed })
			const [forkOut, upstreamOut] = await Promise.all([
				harness.runSide(built, 'fork', REPO_ROOT, REPO_ROOT, {
					name: 'large-file',
					files: ['large-file.md'],
					existingIds: []
				}),
				harness.runSide(built, 'upstream', REPO_ROOT, UPSTREAM_WORKTREE, {
					name: 'large-file',
					files: ['large-file.md'],
					existingIds: []
				})
			])
			expect(forkOut.adds.length + forkOut.edits.length).toBeGreaterThan(0)
			expect(upstreamOut.adds.length + upstreamOut.edits.length).toBeGreaterThan(0)
		}
		const report = renderBenchReport(reports, {
			node: process.version,
			platform: `${process.platform}-${process.arch}`,
			pinnedSha: config.upstreamSha,
			date: new Date().toISOString().slice(0, 10),
			sanity: 'adds/edits/deletes/inserts idênticos por cenário/rep/lado; cross-check com parity harness em large-file'
		})
		console.log(`\n${report}\n`)
		const reportPath = path.join(REPO_ROOT, 'tests/parity/.bench-report.md')
		await fs.promises.writeFile(reportPath, `${report}\n`)
		console.log(`[BENCH] report written to ${reportPath}`)
	})
})
