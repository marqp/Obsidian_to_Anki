import { describe, it, expect } from 'vitest'
import {
	escapeRegex,
	OBS_INLINE_MATH_REGEXP,
	OBS_DISPLAY_MATH_REGEXP,
	OBS_CODE_REGEXP,
	OBS_DISPLAY_CODE_REGEXP,
	CODE_CSS_URL,
	ANKI_ICON
} from '../../src/constants'

describe('Constants: escapeRegex and syntax regexes', () => {
	it('escapeRegex properly escapes all special regex characters', () => {
		const specialChars = '-[]{}()*+?.,\\^$|#'
		const escaped = escapeRegex(specialChars)
		const regex = new RegExp(`^${escaped}$`)
		expect(regex.test(specialChars)).toBe(true)
	})

	it('OBS_INLINE_MATH_REGEXP matches inline math without dollar boundary errors', () => {
		const text = 'Here is $x + y = z$ and some regular text'
		const matches = Array.from(text.matchAll(new RegExp(OBS_INLINE_MATH_REGEXP.source, 'g'))).map((m) => m[1])
		expect(matches).toEqual(['x + y = z'])
	})

	it('OBS_DISPLAY_MATH_REGEXP matches block display math', () => {
		const text = 'Formula:\n$$\n\\frac{a}{b} = c\n$$\nDone'
		const matches = Array.from(text.matchAll(new RegExp(OBS_DISPLAY_MATH_REGEXP.source, 'g'))).map((m) => m[1])
		expect(matches).toEqual(['\n\\frac{a}{b} = c\n'])
	})

	it('OBS_CODE_REGEXP and OBS_DISPLAY_CODE_REGEXP match inline and block code', () => {
		const inlineCode = 'Use `console.log()` here'
		expect(OBS_CODE_REGEXP.test(inlineCode)).toBe(true)

		const blockCode = '```typescript\nconst x = 1\n```'
		expect(OBS_DISPLAY_CODE_REGEXP.test(blockCode)).toBe(true)
	})

	it('constants exports valid icon and css url', () => {
		expect(typeof ANKI_ICON).toBe('string')
		expect(ANKI_ICON.startsWith('<path')).toBe(true)
		expect(CODE_CSS_URL).toContain('highlightjs-themes')
	})
})
