import { describe, it, expect, vi, afterEach } from 'vitest'
import type { CachedMetadata } from 'obsidian'
import { AllFile } from '../../src/file'
import { escapeRegex } from '../../src/constants'
import type { FileData } from '../../src/interfaces/settings-interface'
import type { AnkiConnectNote } from '../../src/interfaces/note-interface'

const emptyCache = {} as CachedMetadata

function testFileData(overrides: Partial<FileData> = {}): FileData {
	const template: AnkiConnectNote = {
		deckName: 'Default',
		modelName: '',
		fields: {},
		options: {
			allowDuplicate: true
		},
		tags: ['Obsidian_to_Anki']
	}
	return {
		fields_dict: { Basic: ['Front', 'Back'] },
		custom_regexps: {},
		file_link_fields: {},
		context_fields: {},
		template,
		EXISTING_IDS: new Set<number>(),
		vault_name: 'test-vault',
		FROZEN_REGEXP: new RegExp(escapeRegex('FROZEN') + String.raw` - (.*?):\n((?:[^\n][\n]?)+)`, 'g'),
		DECK_REGEXP: new RegExp(String.raw`^` + escapeRegex('TARGET DECK') + String.raw`(?:\n|: )(.*)`, 'm'),
		TAG_REGEXP: new RegExp(String.raw`^` + escapeRegex('FILE TAGS') + String.raw`(?:\n|: )(.*)`, 'm'),
		NOTE_REGEXP: new RegExp(
			String.raw`^` +
				escapeRegex('START') +
				String.raw`[ ]*\n([\s\S]*?\n)` +
				escapeRegex('END') +
				String.raw`[ ]*`,
			'gm'
		),
		INLINE_REGEXP: new RegExp(escapeRegex('STARTI') + String.raw`(.*?)` + escapeRegex('ENDI'), 'g'),
		EMPTY_REGEXP: /DELETE/g,
		curly_cloze: false,
		highlights_to_cloze: false,
		comment: true,
		add_context: false,
		add_obs_tags: false,
		...overrides
	}
}

function scanAll(content: string, data: FileData): AllFile {
	const file = new AllFile(content, 'note.md', '', data, emptyCache)
	file.scanFile()
	return file
}

const CUSTOM_QA = 'Q::(.*?)\\nA::(.*)'

afterEach(() => {
	vi.restoreAllMocks()
})

describe('custom matches inside primary blocks do not double-count', () => {
	it('skips a custom match inside START/END', () => {
		const file = scanAll(
			'START\nBasic\nFront: Q::qr\nBack: A\nEND',
			testFileData({ custom_regexps: { Basic: 'Q::(.*)' } })
		)

		expect(file.notes_to_add).toHaveLength(1)
		expect(file.regex_notes_to_add).toEqual([])
	})

	it('skips a custom match inside STARTI/ENDI', () => {
		// No trailing text: greedy (.*) would otherwise extend past ENDI.
		const file = scanAll(
			'STARTI[Basic] Front: Q::qr Back: AENDI',
			testFileData({ custom_regexps: { Basic: 'Q::(.*)' } })
		)

		expect(file.inline_notes_to_add).toHaveLength(1)
		expect(file.regex_notes_to_add).toEqual([])
	})
})

describe('custom matches inside code and math do not become cards', () => {
	it('skips customs inside fenced code blocks', () => {
		const file = scanAll('```\nQ::qr\nA::ar\n```', testFileData({ custom_regexps: { Basic: CUSTOM_QA } }))

		expect(file.regex_notes_to_add).toEqual([])
	})

	it('skips customs inside inline code spans', () => {
		// Code span at end of line: greedy (.*) would otherwise extend past
		// the closing backtick.
		const file = scanAll('some text `Q::qr A::ar`', testFileData({ custom_regexps: { Basic: 'Q::(.*)' } }))

		expect(file.regex_notes_to_add).toEqual([])
	})

	it('skips customs inside display math', () => {
		const file = scanAll('$$Q::qr$$', testFileData({ custom_regexps: { Basic: 'Q::(.*)' } }))

		expect(file.regex_notes_to_add).toEqual([])
	})
})

describe('overlapping customs are claimed once, longest pattern wins', () => {
	it('three overlapping patterns yield one note from the longest', () => {
		const file = scanAll(
			'Q::qr\nA::ar',
			testFileData({
				fields_dict: { Basic: ['Front', 'Back'], Mid: ['Front', 'Back'], Other: ['Front', 'Back'] },
				custom_regexps: {
					Basic: 'Q::(.*)',
					Mid: 'Q::(.+)\\nA::ar',
					Other: 'Q::(.*?)\\nA::(.*)'
				}
			})
		)

		// Longest (Other, 18) claims the block; Mid (15) and Basic (7) find
		// their spans contained and skip. Insertion order would add 3 notes.
		expect(file.regex_notes_to_add).toHaveLength(1)
		expect(file.regex_notes_to_add[0].modelName).toBe('Other')
		expect(file.regex_notes_to_add[0].fields).toMatchObject({ Front: 'qr', Back: 'ar' })
	})
})

describe('metadata lines shield customs but keep applying', () => {
	it('shields a custom matching the FROZEN block', () => {
		const file = scanAll(
			'FROZEN - Basic:\nFront: a\nBack: Q::fq\nA::fa\n\nQ::qr\nA::ar',
			testFileData({ custom_regexps: { Basic: CUSTOM_QA } })
		)

		expect(file.regex_notes_to_add).toHaveLength(1)
		expect(file.regex_notes_to_add[0].fields['Front']).toContain('qr')
	})

	it('shields a custom matching the TARGET DECK line, deck still applies', () => {
		const file = scanAll(
			'TARGET DECK: D\nSTART\nBasic\nFront: Q\nBack: A\nEND',
			testFileData({ custom_regexps: { Basic: 'TARGET DECK: (.*)' } })
		)

		expect(file.regex_notes_to_add).toEqual([])
		expect(file.notes_to_add).toHaveLength(1)
		expect(file.notes_to_add[0].deckName).toBe('D')
	})

	it('shields a custom matching the FILE TAGS line', () => {
		const file = scanAll(
			'FILE TAGS: a b\nQ::qr\nA::ar',
			testFileData({ custom_regexps: { Basic: 'FILE TAGS: (.*)' } })
		)

		expect(file.regex_notes_to_add).toEqual([])
		expect(file.global_tags).toBe('a b')
	})
})

describe('FILE TAGS propagate to custom adds', () => {
	it('appends file tags to regex notes', () => {
		const file = scanAll(
			'FILE TAGS: review hard\nQ::qr\nA::ar',
			testFileData({ custom_regexps: { Basic: CUSTOM_QA } })
		)

		expect(file.regex_notes_to_add).toHaveLength(1)
		expect(file.regex_notes_to_add[0].tags).toContain('review')
		expect(file.regex_notes_to_add[0].tags).toContain('hard')
	})
})

describe('empty vs whitespace custom regexps both no-op', () => {
	const content = 'START\nBasic\nFront: Q\nBack: A\nEND\nQ::qr\nA::ar'

	it('empty pattern is skipped by scanFile', () => {
		const file = scanAll(content, testFileData({ custom_regexps: { Basic: '' } }))

		expect(file.regex_notes_to_add).toEqual([])
		expect(file.ignore_spans).toEqual([])
	})

	it('whitespace pattern is disabled by trim semantics', () => {
		const file = scanAll(content, testFileData({ custom_regexps: { Basic: '   ' } }))

		expect(file.regex_notes_to_add).toEqual([])
		// hasCustomRegexps is false, so the NOTE block span is never built —
		// without trim() this would contain one span.
		expect(file.ignore_spans).toEqual([])
	})
})

describe('add_context reaches custom and regular notes', () => {
	function contextCache(): CachedMetadata {
		return {
			headings: [{ heading: 'H', level: 1, position: { start: { offset: 0 }, end: { offset: 0 } } }]
		} as unknown as CachedMetadata
	}

	function contextData(overrides: Partial<FileData> = {}): FileData {
		return testFileData({ add_context: true, context_fields: { Basic: 'Back' }, ...overrides })
	}

	it('appends heading context to regular notes', () => {
		const file = new AllFile('START\nBasic\nFront: Q\nBack: A\nEND', 'note.md', '', contextData(), contextCache())
		file.scanFile()

		expect(file.notes_to_add).toHaveLength(1)
		expect(file.notes_to_add[0].fields['Back']).toContain('H')
	})

	it('appends heading context to custom notes', () => {
		const file = new AllFile(
			'Q::qr\nA::ar',
			'note.md',
			'',
			contextData({ custom_regexps: { Basic: CUSTOM_QA } }),
			contextCache()
		)
		file.scanFile()

		expect(file.regex_notes_to_add).toHaveLength(1)
		expect(file.regex_notes_to_add[0].fields['Back']).toContain('H')
	})
})

describe('tag arrays pin the historical empty-string element', () => {
	it('keeps the trailing empty tag on tag-less files (wire-visible, do not filter)', () => {
		// global_tags '' splits to ['']: Anki ignores it server-side, but the
		// payload carries it — filtering would be a wire-format change caught
		// by parity, so the junk is pinned, not fixed.
		const regular = scanAll('START\nBasic\nFront: Q\nBack: A\nEND', testFileData())
		expect(regular.notes_to_add[0].tags).toEqual(['Obsidian_to_Anki', ''])

		const custom = scanAll('Q::qr\nA::ar', testFileData({ custom_regexps: { Basic: CUSTOM_QA } }))
		expect(custom.regex_notes_to_add[0].tags).toEqual(['Obsidian_to_Anki', ''])
	})
})
