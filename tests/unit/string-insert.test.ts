import { describe, it, expect } from 'vitest'
import { string_insert } from '../../src/file'

describe('string_insert linear single-pass builder', () => {
	it('matches the docstring example', () => {
		expect(
			string_insert('abcde', [
				[0, 'hi'],
				[3, 'hello'],
				[5, 'beep']
			])
		).toBe('hiabchellodebeep')
	})

	it('returns the text untouched for empty inserts', () => {
		expect(string_insert('abc', [])).toBe('abc')
	})

	it('handles unsorted and adjacent inserts', () => {
		expect(
			string_insert('ab', [
				[2, 'Y'],
				[0, 'X'],
				[1, 'Z']
			])
		).toBe('XaZbY')
	})

	it('stamps many IDs in one pass with exact placement', () => {
		const base = 'x'.repeat(10000)
		const inserts: Array<[number, string]> = Array.from({ length: 100 }, (_, i): [number, string] => [
			i * 100,
			`<!--ID: ${i}-->`
		])
		const result = string_insert(base, inserts)
		expect(result.length).toBe(10000 + inserts.reduce((sum, [, s]) => sum + s.length, 0))
		for (let i = 0; i < 100; i++) {
			expect(result).toContain(`<!--ID: ${i}-->`)
		}
	})

	it('does not mutate the input array', () => {
		const inserts: Array<[number, string]> = [
			[2, 'Y'],
			[0, 'X'],
			[1, 'Z']
		]
		const snapshot = inserts.map(([position, text]) => [position, text] as [number, string])
		string_insert('ab', inserts)
		expect(inserts).toEqual(snapshot)
	})
})
