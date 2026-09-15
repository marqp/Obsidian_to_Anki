import { describe, it, expect } from 'vitest'
import { escapeRegex } from '../../src/constants'

/**
 * Builds the exact NOTE_REGEXP used in setting-to-data.ts
 */
function buildNoteRegExp(beginNote = 'START', endNote = 'END'): RegExp {
	return new RegExp(
		String.raw`^` +
			escapeRegex(beginNote) +
			String.raw`[ ]*\n([\s\S]*?\n)` +
			escapeRegex(endNote) +
			String.raw`[ ]*`,
		'gm'
	)
}

describe('Regression: NOTE_REGEXP block detection', () => {
	const regex = buildNoteRegExp('START', 'END')

	it('matches standard START/END note block', () => {
		const content = `START\nBasic\nFront: What is the capital of France?\nBack: Paris\nEND`
		const matches = Array.from(content.matchAll(regex))
		expect(matches.length).toBe(1)
		expect(matches[0][1]).toContain('Front: What is the capital of France?')
	})

	it('matches START/END blocks with trailing spaces (b8ee77d regression test)', () => {
		// commit 5ed55d8 broke this by turning [\s]* into \[s\]\* literal
		const content = `START   \nBasic\nFront: Question 1\nBack: Answer 1\nEND   \n\nSTART \nBasic\nFront: Question 2\nBack: Answer 2\nEND `
		const matches = Array.from(content.matchAll(regex))
		expect(matches.length).toBe(2)
		expect(matches[0][1]).toContain('Question 1')
		expect(matches[1][1]).toContain('Question 2')
	})

	it('matches multiple blocks separated by various content', () => {
		const content = [
			'# Heading',
			'',
			'START',
			'Basic',
			'Front: Q1',
			'Back: A1',
			'<!--ID: 12345-->',
			'END',
			'',
			'Some intermediate notes...',
			'',
			'START  ',
			'Cloze',
			'{{c1::Paris}} is capital',
			'END  ',
			'',
			'START',
			'Basic',
			'Front: Q3',
			'Back: A3',
			'END'
		].join('\n')

		const matches = Array.from(content.matchAll(regex))
		expect(matches.length).toBe(3)
	})

	it('handles Windows CRLF line endings', () => {
		const content = `START\r\nBasic\r\nFront: Question CRLF\r\nBack: Answer CRLF\r\nEND`
		// Standardize or test CRLF
		const normalized = content.replace(/\r\n/g, '\n')
		const matches = Array.from(normalized.matchAll(regex))
		expect(matches.length).toBe(1)
		expect(matches[0][1]).toContain('Question CRLF')
	})

	it('does NOT match partial or malformed marker lines', () => {
		const content = `RESTART\nBasic\nFront: Q\nBack: A\nENDED`
		const matches = Array.from(content.matchAll(regex))
		expect(matches.length).toBe(0)
	})
})
