import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { buildSides, cleanBuiltSides, createParityHarness } from './parity-harness'
import type { ParityOutput, ParityWarning } from './parity-types'
import config from './config.json'

const REPO_ROOT = path.resolve(__dirname, '../..')
const FIXTURES_DIR = path.join(REPO_ROOT, 'tests/parity/fixtures')
const UPSTREAM_WORKTREE = process.env.PARITY_UPSTREAM_WORKTREE ?? '/tmp/parity-upstream'

function warningsKey(warnings: ParityWarning[]): string {
	return [...warnings]
		.sort((a, b) => (a.category < b.category ? -1 : 1))
		.map((w) => `${w.category}:${w.count}`)
		.join(',')
}

function comparable(output: ParityOutput): string {
	return JSON.stringify(
		{
			adds: output.adds,
			edits: output.edits,
			deletes: output.deletes,
			inserts: output.inserts,
			finalMarkdown: output.finalMarkdown,
			warnings: warningsKey(output.warnings)
		},
		null,
		2
	)
}

interface FixtureManifest {
	files: string[]
	existingIds: number[]
	customRegexps?: Record<string, string>
}

const KNOWN_DIVERGENT = new Set(['target-deck-move', 'trailing-spaces'])

describe('parity: fork vs upstream', () => {
	let built: Awaited<ReturnType<typeof buildSides>> | null = null
	let fixtureNames: string[] = []

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
		const entries = await fs.promises.readdir(FIXTURES_DIR, { withFileTypes: true })
		fixtureNames = entries
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.sort()
		expect(fixtureNames.length).toBeGreaterThan(0)
	}, 180000)

	afterAll(async () => {
		if (built) {
			await cleanBuiltSides(built)
		}
		await fs.promises.rm(path.join(REPO_ROOT, 'tests/parity/.helpers.mjs'), { force: true })
	})

	it('documents the pinned upstream SHA under test', () => {
		expect(config.upstreamSha).toMatch(/^[0-9a-f]{40}$/)
	})

	it('compares every fixture directory on both sides', async () => {
		if (!built) {
			throw new Error('parity bundles were not built')
		}
		const failures: string[] = []
		const diffs: Record<string, { fork: string; upstream: string }> = {}
		for (const name of fixtureNames) {
			const manifest = JSON.parse(
				await fs.promises.readFile(path.join(FIXTURES_DIR, name, 'fixture.json'), 'utf8')
			) as FixtureManifest
			const fixture = {
				name,
				files: manifest.files,
				existingIds: manifest.existingIds,
				customRegexps: manifest.customRegexps
			}
			const harness = createParityHarness({ existingIds: [], idSeed: 900001 })
			const [fork, upstream] = await Promise.all([
				harness.runSide(built, 'fork', REPO_ROOT, REPO_ROOT, fixture),
				harness.runSide(built, 'upstream', REPO_ROOT, UPSTREAM_WORKTREE, fixture)
			])
			const forkText = comparable(fork)
			const upstreamText = comparable(upstream)
			if (upstreamText !== forkText && !KNOWN_DIVERGENT.has(name)) {
				failures.push(name)
				diffs[name] = { fork: forkText.slice(0, 3000), upstream: upstreamText.slice(0, 3000) }
			}
		}
		if (failures.length > 0) {
			console.log(`parity diffs in: ${failures.join(', ')}\n` + JSON.stringify(diffs, null, 2).slice(0, 6000))
		}
		expect(failures).toEqual([])
	}, 180000)
})
