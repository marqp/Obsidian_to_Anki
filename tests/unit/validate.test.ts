import { describe, it, expect } from 'vitest'
import { validateFiles, type ValidationInput } from '../../src/validate'
import { createFileData } from '../../src/scan-optimizations'
import { createParsedSettings } from './anki-test-helpers'

const data = createFileData(
	createParsedSettings({
		fields_dict: { Basic: ['Front', 'Back'], Cloze: ['Text', 'Extra'] },
		curly_cloze: true,
		highlights_to_cloze: true
	}),
	'Default',
	[]
)

const input = (text: string, path = 'a.md'): ValidationInput => ({ path, text, data })
const check = (texts: ValidationInput[], existingIds?: number[]) =>
	validateFiles(texts, { beginNote: 'START', existingIds: existingIds && new Set(existingIds) })
const kinds = (texts: ValidationInput[], existingIds?: number[]) =>
	check(texts, existingIds).issues.map((issue) => issue.kind)

describe('validateFiles', () => {
	it('passes well-formed cards, including a real Extra field on Cloze', () => {
		const report = check([
			input('START\nBasic\nFront: q\nBack: a\nEND\n\nSTART\nCloze\nThe ==term== here\nExtra: why\nEND\n')
		])

		expect(report).toMatchObject({ filesChecked: 1, blocks: 2, errors: 0, warnings: 0, issues: [] })
	})

	it('finds a Cloze without deletions with the real parser, at its line', () => {
		const report = check([input('# H\n\nSTART\nCloze\nNo deletion here\nEND\n')])

		expect(report.errors).toBe(1)
		expect(report.issues[0]).toMatchObject({ kind: 'cloze-without-deletions', severity: 'error', line: 3 })
	})

	it('warns about a label that is not a field of the note type, at its line', () => {
		const report = check([input('START\nBasic\nFront: q\nBack: a\nExtra: context\nEND\n')])

		expect(report).toMatchObject({ errors: 0, warnings: 1, byKind: { 'literal-field-label': 1 } })
		expect(report.issues[0]).toMatchObject({ severity: 'warning', line: 5, snippet: 'Extra: context' })
	})

	it('warns about a Basic block with no "Back:" line, whose answer went to the front', () => {
		const report = check([input('# H\n\nSTART\nBasic\nFront: q\nthe answer\nEND\n')])

		expect(report).toMatchObject({ errors: 0, warnings: 1, byKind: { 'missing-back-label': 1 } })
		expect(report.issues[0]).toMatchObject({
			kind: 'missing-back-label',
			severity: 'warning',
			line: 3,
			snippet: 'Basic Front: q the answer',
			message:
				'No line starts with "Back:", so the whole block went to Front and the card has no answer. Start the answer with "Back:".'
		})
	})

	it('does not ask for "Back:" in note types without a Back field, or where the word is not a label', () => {
		expect(kinds([input('START\nCloze\nThe ==term==\nmore text\nEND\n')])).toEqual([])
		expect(kinds([input('START\nBasic\nFront: q\nnot Back: here\nEND\n')])).toEqual(['missing-back-label'])
		expect(kinds([input('START\nBasic\nFront: q\nBack:\nEND\n')])).toEqual([])
	})

	it('finds a block with no end marker at the end of a file', () => {
		const report = check([input('START\nBasic\nFront: q\nBack: a\n')])

		expect(report.issues).toEqual([expect.objectContaining({ kind: 'unterminated-block', line: 1 })])
	})

	it('finds a missing end marker that merged two blocks', () => {
		const text = 'START\nBasic\nFront: one\n\nSTART\nBasic\nFront: two\nEND\n'

		expect(kinds([input(text)])).toEqual(['unterminated-block'])
	})

	it('finds a line whose first letters close the block early', () => {
		const report = check([input('START\nBasic\nFront: q\nBack:\nENDOSCOPIA digestiva\nEND\n')])

		expect(report.issues[0]).toMatchObject({ kind: 'end-marker-collision', line: 5 })
	})

	it('finds an ID reused inside a file', () => {
		const block = 'START\nBasic\nFront: q\nBack: a\n<!--ID: 7-->\nEND\n\n'

		expect(kinds([input(block + block)])).toEqual(['duplicate-note-id'])
	})

	it('finds an ID shared between files, on both of them', () => {
		const block = 'START\nBasic\nFront: q\nBack: a\n<!--ID: 7-->\nEND\n'
		const report = check([input(block, 'a.md'), input(`\n\n${block}`, 'b.md')])

		expect(report.issues.map((i) => [i.file, i.kind, i.line, i.noteId])).toEqual([
			['a.md', 'duplicate-note-id', 5, 7],
			['b.md', 'duplicate-note-id', 7, 7]
		])
	})

	it('with Anki available, flags IDs it does not know', () => {
		const report = check([input('START\nBasic\nFront: q\nBack: a\n<!--ID: 7-->\nEND\n')], [8])

		expect(report).toMatchObject({ ankiChecked: true, byKind: { 'stale-note-id': 1 } })
	})

	it('with Anki closed, does not accuse any ID of being missing', () => {
		const report = check([input('START\nBasic\nFront: q\nBack: a\n<!--ID: 7-->\nEND\n')])

		expect(report).toMatchObject({ ankiChecked: false, errors: 0 })
	})

	it('ignores IDs in code fences and DELETE lines when looking for shared IDs', () => {
		const block = 'START\nBasic\nFront: q\nBack: a\n<!--ID: 7-->\nEND\n'

		expect(kinds([input(block, 'a.md'), input('```\n<!--ID: 7-->\n```\n', 'b.md')])).toEqual([])
		expect(kinds([input(block, 'a.md'), input('DELETE\n<!--ID: 7-->\n', 'b.md')])).toEqual([])
	})
})
