import esbuild from 'esbuild'
import { builtinModules } from 'module'

const production = process.argv.includes('production')
const watch = process.argv.includes('watch')

// Mirrors the Obsidian sample plugin: CJS bundle, browser platform (Electron
// renderer), Obsidian API + Node builtins external (desktop-only plugin).
const BUILD_OPTIONS = {
	entryPoints: ['main.ts'],
	bundle: true,
	external: ['obsidian', 'electron', ...builtinModules],
	format: 'cjs',
	target: 'es2022',
	logLevel: 'info',
	sourcemap: production ? false : 'inline',
	treeShaking: true,
	outfile: 'main.js',
	minify: production
}

async function run() {
	if (watch) {
		const ctx = await esbuild.context(BUILD_OPTIONS)
		await ctx.watch()
		console.log('watching for changes...')
	} else {
		await esbuild.build(BUILD_OPTIONS)
	}
}

run().catch((error) => {
	console.error(error)
	process.exit(1)
})
