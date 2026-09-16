import { describe, it, expect } from 'vitest'
import { isExistingFolder, regexpError, filterFolderPaths } from '../../src/settings'
import { TFolder } from 'obsidian'
import type { App } from 'obsidian'

function appWithFolders(paths: string[]): App {
	const root = new TFolder()
	root.path = ''
	for (const p of paths) {
		const folder = new TFolder()
		folder.path = p
		root.children.push(folder)
	}
	return {
		vault: {
			getAbstractFileByPath: (lookup: string) => {
				if (lookup === '') {
					return root
				}
				return root.children.find((c) => c.path === lookup) ?? null
			}
		}
	} as unknown as App
}

describe('isExistingFolder: Scan Directories inline validation', () => {
	it('accepts vault folders, rejects files/missing/blank paths', () => {
		const app = appWithFolders(['Cards', 'Cards/Deep'])
		expect(isExistingFolder(app, 'Cards')).toBe(true)
		expect(isExistingFolder(app, 'Cards/Deep')).toBe(true)
		expect(isExistingFolder(app, 'Missing')).toBe(false)
		expect(isExistingFolder(app, '')).toBe(false)
		expect(isExistingFolder(app, '  ')).toBe(false)
	})

	it('never throws on a bare mock vault', () => {
		const app = { vault: { getAbstractFileByPath: () => null } } as unknown as App
		expect(isExistingFolder(app, 'Anything')).toBe(false)
	})
})

describe('regexpError: custom-regexp inline validation', () => {
	it('treats blank and whitespace as disabled (no error)', () => {
		expect(regexpError('')).toBeNull()
		expect(regexpError('   ')).toBeNull()
	})

	it('accepts valid patterns, including the built-in template style', () => {
		expect(regexpError('Q::(.*?)\\nA::(.*)')).toBeNull()
		expect(regexpError('(?<field>.*)')).toBeNull()
	})

	it('reports a message for uncompilable patterns', () => {
		const error = regexpError('([')
		expect(error).not.toBeNull()
		expect(error).toMatch(/regular expression/i)
	})
})

describe('filterFolderPaths: folder picker suggestions', () => {
	const paths = ['Cards', 'Cards/Deep', 'Notes', 'Archive/2024']

	it('returns every path for an empty query', () => {
		expect(filterFolderPaths(paths, '')).toEqual(paths)
		expect(filterFolderPaths(paths, '   ')).toEqual(paths)
	})

	it('filters case-insensitively by substring', () => {
		expect(filterFolderPaths(paths, 'cards')).toEqual(['Cards', 'Cards/Deep'])
		expect(filterFolderPaths(paths, '2024')).toEqual(['Archive/2024'])
		expect(filterFolderPaths(paths, 'zzz')).toEqual([])
	})
})
