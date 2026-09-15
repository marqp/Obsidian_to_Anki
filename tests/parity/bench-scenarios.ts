import * as fs from 'node:fs'
import * as path from 'node:path'

export interface BenchScenarioInput {
	name: string
	title: string
	files: Array<{ path: string; content: string }>
	existingIds: number[]
	customRegexps?: Record<string, string>
	reps: number
	warmup: number
}

async function readFixture(repoRoot: string, dir: string, file: string): Promise<string> {
	return fs.promises.readFile(path.join(repoRoot, 'tests/parity/fixtures', dir, file), 'utf8')
}

/**
 * Bench scenarios. Every scenario avoids the KNOWN_DIVERGENT fixtures
 * (target-deck-move, trailing-spaces), so fork and upstream must produce
 * identical add/edit counts on every repetition — enforced by the sanity
 * gate in bench.test.ts. Linearity inputs are generated in memory and
 * never committed.
 */
export async function loadBenchScenarios(repoRoot: string): Promise<BenchScenarioInput[]> {
	const large = await readFixture(repoRoot, 'large-file', 'large-file.md')
	const basicAdd = await readFixture(repoRoot, 'basic-add', 'basic-add.md')
	const inlineNote = await readFixture(repoRoot, 'inline-note', 'inline-note.md')
	const clozeCurly = await readFixture(repoRoot, 'cloze-curly', 'cloze-curly.md')
	const frozen = await readFixture(repoRoot, 'frozen-filetags', 'frozen-filetags.md')
	const unicode = await readFixture(repoRoot, 'unicode-tags', 'unicode-tags.md')
	const rescan = await readFixture(repoRoot, 'update-rescan', 'update-rescan.md')
	const mixed = [basicAdd, inlineNote, clozeCurly, frozen, unicode].join('\n\n')
	const large2 = `${large}\n\n${large}`
	const large4 = `${large2}\n\n${large2}`
	return [
		{
			name: 'cold-500',
			title: 'Cold scan, 500 blocks (large-file.md, ~38KB)',
			files: [{ path: 'large-file/large-file.md', content: large }],
			existingIds: [],
			reps: 30,
			warmup: 5
		},
		{
			name: 'mixed',
			title: 'Mixed small scan, all parse paths (basic+inline+cloze+frozen+unicode)',
			files: [{ path: 'mixed/mixed.md', content: mixed }],
			existingIds: [],
			reps: 50,
			warmup: 5
		},
		{
			name: 'rescan-edit',
			title: 'Rescan with managed IDs (edit path, update-rescan.md)',
			files: [{ path: 'update-rescan/update-rescan.md', content: rescan }],
			existingIds: [900010],
			reps: 50,
			warmup: 5
		},
		{
			name: 'linear-x1',
			title: 'Linearity x1 (500 blocks)',
			files: [{ path: 'linear/linear-x1.md', content: large }],
			existingIds: [],
			reps: 10,
			warmup: 3
		},
		{
			name: 'linear-x2',
			title: 'Linearity x2 (1000 blocks)',
			files: [{ path: 'linear/linear-x2.md', content: large2 }],
			existingIds: [],
			reps: 10,
			warmup: 3
		},
		{
			name: 'linear-x4',
			title: 'Linearity x4 (2000 blocks)',
			files: [{ path: 'linear/linear-x4.md', content: large4 }],
			existingIds: [],
			reps: 10,
			warmup: 3
		}
	]
}
