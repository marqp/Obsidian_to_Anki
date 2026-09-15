import { describe, it, expect } from 'vitest'

describe('Regression: Global RegExp lastIndex persistence across multiple strings', () => {
	// Shared RegExp instance with /g flag
	const NOTE_REGEXP = new RegExp(String.raw`^START[ ]*\n([\s\S]*?\n)END[ ]*`, 'gm')

	it('matchAll resets lastIndex internally and does not corrupt subsequent scans', () => {
		const file1 = 'START\nBasic\nFront: Q1\nBack: A1\nEND'
		const file2 = 'START\nBasic\nFront: Q2\nBack: A2\nEND'

		// Scan file 1
		const matches1 = Array.from(file1.matchAll(NOTE_REGEXP))
		expect(matches1.length).toBe(1)
		expect(matches1[0][1]).toContain('Q1')

		// Scan file 2 with the exact same RegExp instance
		const matches2 = Array.from(file2.matchAll(NOTE_REGEXP))
		expect(matches2.length).toBe(1)
		expect(matches2[0][1]).toContain('Q2')
	})

	it('demonstrates RegExp.test with /g flag mutates lastIndex, whereas matchAll or reset is safe', () => {
		const testRegex = /START[\s\S]*?END/g
		const str = 'START 1 END START 2 END'

		// First test finds first occurrence and advances lastIndex
		expect(testRegex.test(str)).toBe(true)
		expect(testRegex.lastIndex).toBeGreaterThan(0)

		// Resetting lastIndex restores safety
		testRegex.lastIndex = 0
		expect(testRegex.lastIndex).toBe(0)
	})
})
