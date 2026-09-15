import { describe, it, expect } from 'vitest'
import {
	isStatUnchanged,
	isFileUnchanged,
	getFileContentHash,
	mapConcurrent,
	FileHashes
} from '../../src/scan-optimizations'
import { cloneTemplate } from '../../src/note'
import { FormatConverter } from '../../src/format'
import type { AnkiConnectNote } from '../../src/interfaces/note-interface'

describe('Performance: mtime and size stat cache and backward compatibility', () => {
	const content = 'START\nBasic\nFront: Q\nBack: A\nEND'
	const hash = getFileContentHash(content)

	it('isStatUnchanged returns true only when both mtime and size match', () => {
		const cached = { hash, mtime: 1700000000, size: 45 }

		expect(isStatUnchanged({ mtime: 1700000000, size: 45 }, cached)).toBe(true)
		expect(isStatUnchanged({ mtime: 1700000001, size: 45 }, cached)).toBe(false)
		expect(isStatUnchanged({ mtime: 1700000000, size: 46 }, cached)).toBe(false)
		expect(isStatUnchanged(undefined, cached)).toBe(false)
		expect(isStatUnchanged({ mtime: 1700000000, size: 45 }, undefined)).toBe(false)
		expect(isStatUnchanged({ mtime: 1700000000, size: 45 }, { hash })).toBe(false)
	})

	it('isStatUnchanged returns false for legacy string entries to force hash calculation', () => {
		const legacyCache: FileHashes = {
			'note.md': hash
		}
		// Legacy string entry cannot be stat-verified, must return false for safe fallback
		expect(isStatUnchanged({ mtime: 1700000000, size: 45 }, legacyCache['note.md'])).toBe(false)
	})

	it('isFileUnchanged works seamlessly with both modern object and legacy string caches', () => {
		const modernCache: FileHashes = {
			'modern.md': { hash, mtime: 1700000000, size: 45 }
		}
		const legacyCache: FileHashes = {
			'legacy.md': hash
		}

		expect(isFileUnchanged('modern.md', content, modernCache)).toBe(true)
		expect(isFileUnchanged('modern.md', content + ' changed', modernCache)).toBe(false)
		expect(isFileUnchanged('nonexistent.md', content, modernCache)).toBe(false)

		expect(isFileUnchanged('legacy.md', content, legacyCache)).toBe(true)
		expect(isFileUnchanged('legacy.md', content + ' changed', legacyCache)).toBe(false)
	})
})

describe('Performance: mapConcurrent bounded async execution', () => {
	it('executes all items and preserves order', async () => {
		const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
		let activeWorkers = 0
		let maxConcurrent = 0

		const results = await mapConcurrent(items, 3, async (num, idx) => {
			activeWorkers++
			maxConcurrent = Math.max(maxConcurrent, activeWorkers)
			await new Promise((r) => setTimeout(r, 5))
			activeWorkers--
			return num * 10 + idx
		})

		expect(results).toEqual([10, 21, 32, 43, 54, 65, 76, 87, 98, 109])
		expect(maxConcurrent).toBe(3)
	})

	it('handles concurrency limits and boundary conditions', async () => {
		let ran = false
		const emptyResults = await mapConcurrent([], 5, async () => {
			ran = true
			return 'called'
		})
		expect(emptyResults).toEqual([])
		expect(ran).toBe(false)

		const singleResult = await mapConcurrent([42], 10, async (x) => x * 2)
		expect(singleResult).toEqual([84])

		const zeroConcurrency = await mapConcurrent([1, 2], 0, async (x) => x + 1)
		expect(zeroConcurrency).toEqual([2, 3])
	})
})

describe('Performance: cloneTemplate deep copy', () => {
	it('isolates tags, fields, and options across notes', () => {
		const baseTemplate: AnkiConnectNote = {
			deckName: 'Default',
			modelName: 'Basic',
			fields: { Front: 'Q', Back: 'A' },
			options: { allowDuplicate: false, duplicateScope: 'deck' },
			tags: ['Base']
		}

		const clone1 = cloneTemplate(baseTemplate)
		const clone2 = cloneTemplate(baseTemplate)

		clone1.tags.push('ExtraTag')
		clone1.fields['Front'] = 'Modified'
		clone1.options.allowDuplicate = true

		expect(clone2.tags).toEqual(['Base'])
		expect(clone2.fields['Front']).toBe('Q')
		expect(clone2.options.allowDuplicate).toBe(false)
		expect(baseTemplate.tags).toEqual(['Base'])
	})
})

describe('Performance: FormatConverter memoization & fast-path', () => {
	it('memoizes identical formatting requests', () => {
		const formatter = new FormatConverter({} as any, 'test-vault')
		const text = 'Simple note text with **bold**'

		const first = formatter.format(text, false, false)
		const second = formatter.format(text, false, false)

		expect(first).toBe(second)
	})
})
