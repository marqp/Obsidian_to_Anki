import { describe, it, expect } from 'vitest'
import { FormatConverter } from '../../src/format'

function createFormatter() {
	return new FormatConverter({} as never, 'test-vault')
}

describe('FormatConverter.censor', () => {
	it('collects matches and substitutes in a single pass', () => {
		const formatter = createFormatter()
		const [censored, matches] = formatter.censor('a `x` b `yz` c', /`[^`]+`/g, 'MASK')
		expect(censored).toBe('a MASK b MASK c')
		expect(matches).toEqual(['`x`', '`yz`'])
	})

	it('returns the text untouched when nothing matches', () => {
		const formatter = createFormatter()
		const [censored, matches] = formatter.censor('plain text', /`[^`]+`/g, 'MASK')
		expect(censored).toBe('plain text')
		expect(matches).toEqual([])
	})
})

describe('FormatConverter.decensor', () => {
	it('restores placeholders in order, with and without escaping', () => {
		const formatter = createFormatter()
		expect(formatter.decensor('The MASK is worth MASK today', 'MASK', ['10', '15'], false)).toBe(
			'The 10 is worth 15 today'
		)
		expect(formatter.decensor('a MASK b', 'MASK', ['<x>'], true)).toBe('a &lt;x&gt; b')
	})

	it('throws the same mismatch error on too few replacements', () => {
		const formatter = createFormatter()
		expect(() => formatter.decensor('a MASK b MASK c', 'MASK', ['10'], false)).toThrow(
			/Mismatch between placeholders/
		)
	})

	it('throws the same mismatch error on too many replacements', () => {
		const formatter = createFormatter()
		expect(() => formatter.decensor('a MASK b', 'MASK', ['10', '15'], false)).toThrow(
			/Mismatch between placeholders/
		)
	})
})

describe('FormatConverter.format_note_with_url', () => {
	it('labels the backlink with the source filename (upstream #557)', () => {
		const formatter = createFormatter()
		const note = { fields: { Front: 'Q' } } as never
		formatter.format_note_with_url(
			note,
			'obsidian://open?vault=test-vault&file=' + encodeURIComponent('sub/notes.md'),
			'Front'
		)
		expect((note as { fields: Record<string, string> }).fields['Front']).toContain('>Obsidian - notes</a>')
	})

	it('falls back to a bare Obsidian label when the url has no file part', () => {
		const formatter = createFormatter()
		const note = { fields: { Front: 'Q' } } as never
		formatter.format_note_with_url(note, 'obsidian://open?vault=test-vault', 'Front')
		expect((note as { fields: Record<string, string> }).fields['Front']).toContain('>Obsidian</a>')
	})
})

describe('FormatConverter.format spot-checks', () => {
	it('keeps inline code intact through censor/decensor', () => {
		const formatter = createFormatter()
		const out = formatter.format('Use `print(1)` here', false, false)
		expect(out).toContain('<code>print(1)</code>')
	})

	it('keeps fenced code blocks intact through censor/decensor', () => {
		const formatter = createFormatter()
		const out = formatter.format('Before\n```python\nprint(1)\n```\nAfter', false, false)
		expect(out).toContain('<pre><code')
		expect(out).toContain('print')
	})

	it('converts Obsidian math to Anki math delimiters', () => {
		const formatter = createFormatter()
		expect(formatter.format('Value $x+1$ end', false, false)).toContain('\\(x+1\\)')
		expect(formatter.format('Value $$x+1$$ end', false, false)).toContain('\\[x+1\\]')
	})
})
