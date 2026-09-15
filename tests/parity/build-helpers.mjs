import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

/**
 * Per-side settings builder, compiled against that side's own sources so the
 * parity run exercises each engine's genuine regexes, template and formatting
 * pipeline. Runs under plain node (no Vitest): `obsidian` resolves to the
 * shared mock and AnkiConnect.invoke is stubbed to canned EXISTING_IDS, so
 * no Anki, Electron or network is involved.
 *
 * Usage: node tests/parity/build-helpers.mjs <fork|upstream> <sourceRoot> <outFile>
 */
async function main() {
	const [side, sourceRoot, outFile] = process.argv.slice(2)
	if (!side || !sourceRoot || !outFile) {
		throw new Error('usage: build-helpers.mjs <fork|upstream> <sourceRoot> <outFile>')
	}
	const dir = await fs.promises.mkdtemp(path.join(sourceRoot, `.parity-helpers-${side}-`))
	const entry = path.join(sourceRoot, `.parity-helpers-entry-${side}.ts`)
	try {
		await fs.promises.writeFile(
			entry,
			[
				...(side === 'upstream' ? [`import './.parity-xhr-shim-${side}.mjs';`, ''] : []),
				"import { settingToData } from './src/setting-to-data'",
				'',
				'const FIELDS_DICT = { Basic: ["Front", "Back"], Cloze: ["Text", "BackExtra"] };',
				'',
				'const SETTINGS = {',
				"  CUSTOM_REGEXPS: {},",
				"  FILE_LINK_FIELDS: {},",
				"  CONTEXT_FIELDS: {},",
				"  FOLDER_DECKS: {},",
				"  FOLDER_TAGS: {},",
				'  Syntax: { "Begin Note": "START", "End Note": "END", "Begin Inline Note": "STARTI", "End Inline Note": "ENDI", "Target Deck Line": "TARGET DECK", "File Tags Line": "FILE TAGS", "Delete Note Line": "DELETE", "Frozen Fields Line": "FROZEN" },',
				'  Defaults: { "Scan Directories": [], Tag: "Obsidian_to_Anki", Deck: "Default", "Scheduling Interval": 0, "Add File Link": false, "Add Context": false, CurlyCloze: true, "CurlyCloze - Highlights to Clozes": false, "ID Comments": true, "Add Obsidian Tags": false },',
				'  IGNORED_FILE_GLOBS: []',
				'};',
				'',
				'export async function buildParityFileData(existingIds, customRegexps) {',
			...(side === 'upstream'
				? [
						"  const { setParityExistingIds } = await import('./.parity-xhr-shim-upstream.mjs');",
						'  setParityExistingIds(existingIds);'
					]
				: []),
			'  const AnkiConnect = await import("./src/anki");',
			'  if (typeof AnkiConnect.setTransport === "function") {',
			'    AnkiConnect.setTransport({ invoke: async (action) => { if (action === "findNotes") return existingIds; throw new Error("unexpected AnkiConnect action in parity build: " + action); } });',
			'  }',
			'  const app = { vault: { getName: () => "parity-vault" } };',
			'  if (customRegexps) { SETTINGS.CUSTOM_REGEXPS = customRegexps; }',
			'  return settingToData(app, SETTINGS, FIELDS_DICT);',
			'}',
				''
			].join('\n')
		)
		// The XHR shim lives in the main repo (tests/parity/xhr-shim.mjs) and must
		// be resolvable from the bundle: copy it next to the generated entry so
		// the relative import works for both the fork and the worktree builds.
		const repoRoot = process.cwd()
		await fs.promises.copyFile(
			path.join(repoRoot, 'tests/parity/xhr-shim.mjs'),
			path.join(sourceRoot, `.parity-xhr-shim-${side}.mjs`)
		)
		await build({
			entryPoints: [entry],
			bundle: true,
			platform: 'node',
			format: 'esm',
			outfile: outFile,
			absWorkingDir: sourceRoot,
			alias: { obsidian: path.join(repoRoot, 'tests/mocks/obsidian.ts') },
			external: ['path'],
			logLevel: 'silent',
			// The worktree predates the TS6-era config; resolve its legacy
			// tsconfig quirks at bundle time without touching its sources.
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
		const check = await import(pathToFileURL(outFile).href)
		if (typeof check.buildParityFileData !== 'function') {
			throw new Error('helpers bundle did not export buildParityFileData')
		}
	} finally {
		await fs.promises.rm(entry, { force: true })
		await fs.promises.rm(path.join(sourceRoot, `.parity-xhr-shim-${side}.mjs`), { force: true })
		await fs.promises.rm(dir, { recursive: true, force: true })
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : error)
	process.exit(1)
})
