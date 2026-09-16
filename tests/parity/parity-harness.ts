import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import type { ParityFixture, ParityOutput } from './parity-types'

export interface ParitySideOutput extends ParityOutput {
	side: 'fork' | 'upstream'
}

interface BuiltSide {
	dir: string
	entry: string
}

export type { BuiltSide }

const SIDES = ['fork', 'upstream'] as const
export type ParitySide = (typeof SIDES)[number]

interface BundleAllFile {
	setupScan(): void
	scanNotes(): void
	scanInlineNotes(): void
	search?: (noteType: string, regexp: string) => void
	custom_regexps?: Record<string, string>
	notes_to_add: BundleNote[]
	inline_notes_to_add: BundleNote[]
	regex_notes_to_add: BundleNote[]
	notes_to_edit: Array<{ identifier: number | null; note: BundleNote }>
	notes_to_delete: number[]
	note_ids: Array<number | null>
	writeIDs(): void
	file: string
}

interface BundleNote {
	deckName: string
	modelName: string
	fields: Record<string, string>
	tags: string[]
}

interface ScannedNote {
	deck: string
	model: string
	fields: Record<string, string>
	tags: string[]
}

function toScanned(note: BundleNote): ScannedNote {
	return {
		deck: note.deckName,
		model: note.modelName,
		fields: { ...note.fields },
		tags: [...note.tags].sort()
	}
}

/**
 * Build an isolated bundle per engine side from its own source tree.
 * Each bundle resolves `obsidian` to the shared mock, so no Electron APIs
 * leak into the Node runner. The upstream side compiles from a git worktree
 * pinned by tests/parity/config.json — never from the working tree.
 */
export async function buildSides(repoRoot: string, upstreamWorktree: string): Promise<Record<ParitySide, BuiltSide>> {
	const built = {} as Record<ParitySide, BuiltSide>
	const roots: Record<ParitySide, string> = { fork: repoRoot, upstream: upstreamWorktree }
	for (const side of SIDES) {
		const dir = await fs.promises.mkdtemp(path.join(repoRoot, `tests/parity/.build-${side}-`))
		await build({
			entryPoints: [path.join(roots[side], 'src', 'file.ts')],
			bundle: true,
			platform: 'node',
			format: 'cjs',
			outfile: path.join(dir, 'file.cjs'),
			alias: {
				obsidian: path.join(repoRoot, 'tests/mocks/obsidian.ts'),
				// The pinned upstream imports the v1 deep path 'ts-md5/dist/md5',
				// removed in ts-md5 v2. Alias it to the v2 root entry: the hash
				// algorithm is byte-identical (verified vector-for-vector), so
				// this preserves parity semantics without touching upstream sources.
				'ts-md5/dist/md5': path.join(repoRoot, 'node_modules', 'ts-md5', 'dist', 'index.cjs.js')
			},
			external: ['path'],
			// Resolve third-party imports (showdown, ts-md5) from the fork's
			// own node_modules: it has the same dependency names as the
			// pinned upstream (verified against its package.json).
			// NOTE: `showdown-highlight` is kept as a fork devDependency
			// solely so the pinned upstream's src/format.ts can build here —
			// the fork bundle no longer ships it (see src/highlight.ts).
			nodePaths: [path.join(repoRoot, 'node_modules')],
			logLevel: 'silent',
			// Same legacy-config handling as build-helpers.mjs: the pinned
			// upstream predates the TS6-era tsconfig, so resolve its quirks
			// at bundle time without touching its sources.
			tsconfigRaw: JSON.stringify({
				compilerOptions: {
					target: 'es2020',
					module: 'commonjs',
					moduleResolution: 'node',
					esModuleInterop: true,
					allowSyntheticDefaultImports: true,
					skipLibCheck: true,
					strict: false
				}
			})
		})
		built[side] = { dir, entry: path.join(dir, 'file.cjs') }
	}
	return built
}

/** Remove per-run bundle dirs; keeps .gitignore simple. */
export async function cleanBuiltSides(built: Record<ParitySide, BuiltSide>): Promise<void> {
	for (const side of SIDES) {
		await fs.promises.rm(built[side].dir, { recursive: true, force: true })
	}
}

export interface HarnessOptions {
	existingIds: number[]
	storedNoteIds?: Record<string, number[]>
	idSeed?: number
}

interface WarningBucket {
	'unknown-id': number
	'unknown-model': number
	'cloze-skip': number
	other: number
}

/**
 * Create the per-side scan harness. The adapter layer is intentionally thin:
 * both engines expose AllFile with setupScan/scanNotes/scanInlineNotes (+
 * search on RegexFile-capable builds), so one code path drives both bundles.
 * FileData is built per side from that side's own settingToData, so each
 * engine runs its genuine regexes and formatting pipeline.
 */
export function createParityHarness(options: HarnessOptions) {
	/**
	 * Manifest-driven fixture options. `customRegexps` is per-fixture because
	 * only some engines-side parity cases (the custom-regexp suite) need it;
	 * everything else shares the stock parity settings.
	 */
	async function runSide(
		built: Record<ParitySide, BuiltSide>,
		side: ParitySide,
		repoRoot: string,
		sourceRoot: string,
		fixture: { name: string; files: string[]; existingIds: number[]; customRegexps?: Record<string, string> }
	): Promise<ParitySideOutput> {
		const bucket: WarningBucket = { 'unknown-id': 0, 'unknown-model': 0, 'cloze-skip': 0, other: 0 }
		const errors: string[] = []
		const originalWarn = console.warn
		const originalError = console.error
		console.warn = (...args: unknown[]) => {
			const text = args.map(String).join(' ')
			if (/does not exist in Anki/.test(text)) {
				bucket['unknown-id'] += 1
			} else if (/Did not recognise note type/.test(text)) {
				bucket['unknown-model'] += 1
			} else {
				bucket.other += 1
			}
		}
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(' '))
		}
		try {
			const bundle = (await import(pathToFileURL(built[side].entry).href)) as {
				AllFile: new (
					contents: string,
					path: string,
					url: string,
					data: unknown,
					cache: unknown
				) => BundleAllFile
			}
			const settingsModule = (await import(
				pathToFileURL(path.join(sourceRoot, 'tests/parity/.helpers.mjs')).href
			)) as {
				buildParityFileData: (ids: number[], customRegexps?: Record<string, string>) => Promise<unknown>
			}
			const data = await settingsModule.buildParityFileData(fixture.existingIds, fixture.customRegexps)
			const perFile: Array<{ path: string; content: string }> = []
			for (const rel of fixture.files) {
				const content = await fs.promises.readFile(
					path.join(repoRoot, 'tests/parity/fixtures', fixture.name, rel),
					'utf8'
				)
				perFile.push({ path: `${fixture.name}/${rel}`, content })
			}
			const adds: ParitySideOutput['adds'] = []
			const edits: ParitySideOutput['edits'] = []
			const deletes: ParitySideOutput['deletes'] = []
			const inserts: ParitySideOutput['inserts'] = []
			const finalMarkdown: Record<string, string> = {}
			const idSeed = options.idSeed ?? 900001
			let nextId = idSeed
			for (const { path: filePath, content } of perFile) {
				const file = new bundle.AllFile(content, filePath, '', data, {})
				file.setupScan()
				file.scanNotes()
				file.scanInlineNotes()
				const customRegexps = file.custom_regexps ?? {}
				for (const noteType of Object.keys(customRegexps)) {
					const regexp = customRegexps[noteType]
					if (regexp && typeof file.search === 'function') {
						file.search(noteType, regexp)
					}
				}
				for (const note of [...file.notes_to_add, ...file.inline_notes_to_add, ...file.regex_notes_to_add]) {
					adds.push(toScanned(note))
				}
				for (const edit of file.notes_to_edit) {
					if (edit.identifier == null) {
						continue
					}
					edits.push({ id: edit.identifier, ...toScanned(edit.note) })
				}
				for (const id of file.notes_to_delete) {
					deletes.push(id)
				}
				const fileAdds =
					file.notes_to_add.length + file.inline_notes_to_add.length + file.regex_notes_to_add.length
				const newIds = Array.from({ length: fileAdds }, () => nextId++)
				file.note_ids = [...newIds]
				file.writeIDs()
				newIds.forEach((id) => inserts.push({ path: filePath, id }))
				finalMarkdown[filePath] = file.file
			}
			return {
				side,
				adds,
				edits,
				deletes: [...deletes].sort((a, b) => a - b),
				inserts,
				finalMarkdown,
				warnings: (['unknown-id', 'unknown-model', 'cloze-skip', 'other'] as const).flatMap((category) =>
					bucket[category] > 0 ? [{ category, count: bucket[category] }] : []
				),
				errors
			}
		} finally {
			console.warn = originalWarn
			console.error = originalError
		}
	}

	return { runSide }
}
