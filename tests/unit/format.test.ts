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

	it('censors inline code containing whitespace', () => {
		const formatter = createFormatter()
		expect(formatter.format('Use `a b` here', false, false)).toContain('<code>a b</code>')
	})

	it('shields braced text inside code from curly-cloze numbering', () => {
		const formatter = createFormatter()
		const out = formatter.format('`{a b}` and {y}', true, false)

		expect(out).toContain('{a b}')
		expect(out).toContain('{{c1::y}}')
	})
})

describe('FormatConverter.format_note_with_frozen_fields', () => {
	it('appends frozen text per field', () => {
		const formatter = createFormatter()
		const note = { modelName: 'Basic', fields: { Front: 'Q', Back: 'A' } } as never
		formatter.format_note_with_frozen_fields(note, { Basic: { Front: '-frozen-', Back: '-b-' } })

		expect((note as { fields: Record<string, string> }).fields['Front']).toBe('Q-frozen-')
		expect((note as { fields: Record<string, string> }).fields['Back']).toBe('A-b-')
	})

	it('keeps parity-pinned concat semantics for a field with no frozen entry', () => {
		// `'' + undefined` -> "undefined". Reachable when a custom regexp
		// yields more captures than the note type has fields (the junk
		// 'undefined' key); the custom-regexp parity fixture pins upstream's
		// exact behavior — do not "fix" this to ''.
		const formatter = createFormatter()
		const note = { modelName: 'Basic', fields: { undefined: '' } } as never
		formatter.format_note_with_frozen_fields(note, { Basic: {} })

		expect((note as { fields: Record<string, string> }).fields['undefined']).toBe('undefined')
	})
})

describe('FormatConverter.cloze numbering', () => {
	it('numbers unnumbered clozes per call without leaking across instances', () => {
		const first = createFormatter()
		const second = createFormatter()
		expect(first.format('{alpha} and {beta}', true, false)).toContain('{{c1::alpha}}')
		expect(first.format('{alpha} and {beta}', true, false)).toContain('{{c2::beta}}')
		// A fresh instance starts at 1 even after another instance formatted.
		expect(second.format('{gamma}', true, false)).toContain('{{c1::gamma}}')
		// The counter resets after each call on the same instance too.
		expect(first.format('{delta}', true, false)).toContain('{{c1::delta}}')
	})
})

describe('FormatConverter.memoCache', () => {
	it('hits repeated texts within one instance', () => {
		const formatter = createFormatter()
		const out1 = formatter.format('repeat me', false, false)
		const out2 = formatter.format('repeat me', false, false)
		expect(out2).toBe(out1)
		expect((formatter as any).memoCache.size).toBe(1)
	})
})

describe('FormatConverter code highlighting (bundled subset)', () => {
	it('highlights a registered language identically to the old wrapper contract', () => {
		const formatter = createFormatter()
		const out = formatter.format('```python\nprint("a<b>&c")\n```', false, false)

		expect(out).toContain('<code class="hljs python language-python">')
		expect(out).toContain('hljs-built_in')
		expect(out).toContain('print')
		// Entity decode round-trip: showdown escapes, hljs re-escapes.
		expect(out).toContain('&quot;a&lt;b&gt;&amp;c&quot;')
	})

	it('keeps plain (unhighlightable) code escaped without spans', () => {
		const formatter = createFormatter()
		const out = formatter.format('```\n\u9019\u4e0d\u662f\u7a0b\u5f0f\u78bc\n```', false, false)

		expect(out).toContain('<code class="hljs">')
		expect(out).not.toContain('hljs-keyword')
	})

	it('strips the fence language tag from the visible text', () => {
		const formatter = createFormatter()
		const out = formatter.format('```js\nlet a = 1;\n```', false, false)

		expect(out).not.toContain('```')
		expect(out).toContain('<span class="hljs-keyword">let</span> a')
	})

	it('auto-detects a registered language for untagged blocks', () => {
		const formatter = createFormatter()
		const out = formatter.format('```\nSELECT a FROM b;\n```', false, false)

		expect(out).toContain('hljs-keyword')
	})
})
