import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Md5 } from 'ts-md5'
import type { ParsedSettings } from '../../src/interfaces/settings-interface'
import { createFileData, getFileContentHash, isFileUnchanged } from '../../src/scan-optimizations'

function createParsedSettings(existingIdCount = 3): ParsedSettings {
	return {
		fields_dict: { Basic: ['Front', 'Back'] },
		custom_regexps: { Basic: '' },
		file_link_fields: { Basic: 'Front' },
		context_fields: { Basic: 'Back' },
		template: {
			deckName: 'Default',
			modelName: '',
			fields: {},
			options: {
				allowDuplicate: false,
				duplicateScope: 'deck'
			},
			tags: ['Obsidian_to_Anki']
		},
		EXISTING_IDS: new Set(Array.from({ length: existingIdCount }, (_, index) => index + 1)),
		vault_name: 'test-vault',
		FROZEN_REGEXP: /FROZEN/g,
		DECK_REGEXP: /TARGET DECK/m,
		TAG_REGEXP: /FILE TAGS/m,
		NOTE_REGEXP: /START[\s\S]*?END/gm,
		INLINE_REGEXP: /STARTI.*?ENDI/g,
		EMPTY_REGEXP: /DELETE/g,
		curly_cloze: false,
		highlights_to_cloze: false,
		comment: true,
		add_context: false,
		add_obs_tags: false,
		add_file_link: false,
		folder_decks: {},
		folder_tags: {},
		ignored_file_globs: [],
		sync_to_ankiweb: false,
		delete_removed_notes: false,
		allow_note_type_changes: false
	}
}

test('hash cache skips only identical file contents', () => {
	const content = 'START\nBasic\nFront: question\nBack: answer\nEND'
	const hash = getFileContentHash(content)
	const legacyHash = Md5.hashStr(content)

	assert.equal(hash, legacyHash)
	assert.equal(isFileUnchanged('note.md', content, { 'note.md': hash }), true)
	assert.equal(isFileUnchanged('note.md', `${content}\nchanged`, { 'note.md': hash }), false)
	assert.equal(isFileUnchanged('new.md', content, { 'note.md': hash }), false)
})

test('per-file data shares large read-only collections', () => {
	const parsedSettings = createParsedSettings(43_116)
	const fileData = createFileData(parsedSettings, 'Language::French', ['review'])

	assert.strictEqual(fileData.EXISTING_IDS, parsedSettings.EXISTING_IDS)
	assert.strictEqual(fileData.fields_dict, parsedSettings.fields_dict)
	assert.strictEqual(fileData.custom_regexps, parsedSettings.custom_regexps)
	assert.notStrictEqual(fileData.template, parsedSettings.template)
	assert.deepEqual(fileData.template.tags, ['review'])
	assert.equal(fileData.template.deckName, 'Language::French')
	assert.deepEqual(fileData.template.fields, parsedSettings.template.fields)
	assert.notStrictEqual(fileData.template.fields, parsedSettings.template.fields)
	assert.deepEqual(fileData.template.options, parsedSettings.template.options)
	assert.notStrictEqual(fileData.template.options, parsedSettings.template.options)
	assert.deepEqual(parsedSettings.template.tags, ['Obsidian_to_Anki'])
	assert.equal(parsedSettings.template.deckName, 'Default')
})

test('large vault windows reuse one Anki ID set instead of cloning it', () => {
	const parsedSettings = createParsedSettings(43_116)

	for (let index = 0; index < 10_000; index++) {
		const fileData = createFileData(parsedSettings, 'Default', ['review'])
		assert.strictEqual(fileData.EXISTING_IDS, parsedSettings.EXISTING_IDS)
	}
})
