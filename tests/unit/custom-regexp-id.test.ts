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
		FROZEN_REGEXP: /FROZEN/g,
		DECK_REGEXP: /TARGET DECK/m,
		TAG_REGEXP: /FILE TAGS/m,
		NOTE_REGEXP: new RegExp(
			String.raw`^` +
				escapeRegex('START') +
				String.raw`[ ]*\n([\s\S]*?\n)` +
				escapeRegex('END') +
				String.raw`[ ]*`,
			'gm'
		),
		INLINE_REGEXP: /STARTI.*?ENDI/g,
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

describe('custom regexp with managed IDs (search_id path)', () => {
	it('edits instead of adding when the ID exists in Anki', () => {
		const file = scanAll(
			'Q::qr\nA::ar\n<!--ID: 777-->',
			testFileData({ custom_regexps: { Basic: CUSTOM_QA }, EXISTING_IDS: new Set([777]) })
		)

		expect(file.regex_notes_to_add).toEqual([])
		expect(file.notes_to_edit).toHaveLength(1)
		expect(file.notes_to_edit[0].identifier).toBe(777)
		// The ID pass claims the span, so the later no-ID passes add nothing.
		expect(file.pendingAdds).toEqual([])
	})

	it('warn-skips an unknown ID without adding or editing', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		const file = scanAll(
			'Q::qr\nA::ar\n<!--ID: 999999-->',
			testFileData({ custom_regexps: { Basic: CUSTOM_QA }, EXISTING_IDS: new Set<number>() })
		)

		expect(file.regex_notes_to_add).toEqual([])
		expect(file.notes_to_edit).toEqual([])
		expect(warnSpy.mock.calls.some((args) => args.map(String).join(' ').includes('999999'))).toBe(true)
	})

	it('Cloze custom without cloze pops the span and adds nothing', () => {
		const data = testFileData({
			fields_dict: { Basic: ['Front', 'Back'], Cloze: ['Text', 'Extra'] },
			custom_regexps: { Cloze: CUSTOM_QA },
			curly_cloze: true,
			EXISTING_IDS: new Set<number>()
		})
		const file = new AllFile('Q::plain\nA::no cloze\n<!--ID: 5-->', 'note.md', '', data, emptyCache)
		file.setupScan()
		const before = file.ignore_spans.length
		file.search('Cloze', CUSTOM_QA)

		// buildAnkiNote forces CLOZE_ERROR (42) for cloze-less Cloze notes;
		// resolveParsed returns false and search() undoes the span booking.
		expect(file.regex_notes_to_add).toEqual([])
		expect(file.notes_to_edit).toEqual([])
		expect(file.ignore_spans.length).toBe(before)
	})
})

describe('Cloze blocks without cloze markup (scanPattern path)', () => {
	function clozeData(existing: number[]): FileData {
		return testFileData({
			fields_dict: { Basic: ['Front', 'Back'], Cloze: ['Text', 'Extra'] },
			curly_cloze: true,
			EXISTING_IDS: new Set(existing)
		})
	}

	it('skips silently instead of warning as unknown', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		const file = scanAll('START\nCloze\nText: plain no cloze\nExtra: x\nEND', clozeData([]))

		expect(file.notes_to_add).toEqual([])
		expect(file.notes_to_edit).toEqual([])
		expect(warnSpy).not.toHaveBeenCalled()
	})

	it('managed CLOZE_ERROR still edits (historical shape)', () => {
		const file = scanAll('START\nCloze\nText: plain no cloze\nExtra: x\nEND', clozeData([42]))

		// Odd but historical: an ID of 42 already managed in Anki takes the
		// edit branch. Pinned so any change is deliberate, not accidental.
		expect(file.notes_to_edit).toHaveLength(1)
		expect(file.notes_to_edit[0].identifier).toBe(42)
	})
})

describe('unknown model vs unknown ID warnings differ', () => {
	it('warns Did not recognise for an unknown note type', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		scanAll('START\nNope\nFront: Q\nBack: A\nEND', testFileData())

		expect(
			warnSpy.mock.calls.some((args) => args.map(String).join(' ').includes('Did not recognise note type'))
		).toBe(true)
		expect(warnSpy.mock.calls.some((args) => args.map(String).join(' ').includes('Nope'))).toBe(true)
	})

	it('warns does-not-exist for a known type with an unmanaged ID', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		scanAll('START\nBasic\nFront: Q\nBack: A\n<!--ID: 999999-->\nEND', testFileData())

		expect(warnSpy.mock.calls.some((args) => args.map(String).join(' ').includes('does not exist in Anki'))).toBe(
			true
		)
		expect(warnSpy.mock.calls.some((args) => args.map(String).join(' ').includes('999999'))).toBe(true)
	})
})
