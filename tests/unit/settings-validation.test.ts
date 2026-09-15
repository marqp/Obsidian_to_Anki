import { describe, it, expect } from 'vitest'
import { isExistingFolder } from '../../src/settings'
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
