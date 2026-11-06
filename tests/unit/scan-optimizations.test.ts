import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Md5 } from 'ts-md5'
import type { ParsedSettings } from '../../src/interfaces/settings-interface'
import {
	FRAME_BUDGET_MS,
	createFileData,
	createYielder,
	getFileContentHash,
	getStoredHash,
	isFileUnchanged,
	isStatUnchanged,
	mapConcurrent,
	pruneFileHashes
} from '../../src/scan-optimizations'

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

test('getStoredHash reads legacy string entries and object hashes', () => {
	const content = 'START\nBasic\nFront: q\nBack: a\nEND'
	const hash = getFileContentHash(content)

	assert.equal(getStoredHash(undefined), undefined)
	assert.equal(getStoredHash('legacy-string-hash'), 'legacy-string-hash')
	assert.equal(getStoredHash({ hash }), hash)
})

test('isFileUnchanged treats legacy string entries as plain hashes', () => {
	const content = 'START\nBasic\nFront: q\nBack: a\nEND'
	const hash = getFileContentHash(content)

	assert.equal(isFileUnchanged('note.md', content, { 'note.md': hash }), true)
	assert.equal(isFileUnchanged('note.md', `${content}\nchanged`, { 'note.md': hash }), false)
})

test('isStatUnchanged requires matching mtime and size on object entries', () => {
	const content = 'START\nBasic\nFront: q\nBack: a\nEND'
	const hash = getFileContentHash(content)

	assert.equal(isStatUnchanged({ mtime: 200, size: 100 }, { hash, mtime: 200, size: 100 }), true)
	assert.equal(isStatUnchanged({ mtime: 201, size: 100 }, { hash, mtime: 200, size: 100 }), false)
	assert.equal(isStatUnchanged({ mtime: 200, size: 101 }, { hash, mtime: 200, size: 100 }), false)
	// Legacy string entries carry no stat shape: never a stat hit.
	assert.equal(isStatUnchanged({ mtime: 200, size: 100 }, hash), false)
	assert.equal(isStatUnchanged(undefined, { hash, mtime: 200, size: 100 }), false)
	assert.equal(isStatUnchanged(undefined, undefined), false)
})

test('mapConcurrent preserves order and handles the empty input', async () => {
	const seen: number[] = []
	const doubled = await mapConcurrent([3, 1, 2], 2, async (value, index) => {
		seen.push(index)
		return value * 2
	})

	assert.deepEqual(doubled, [6, 2, 4])
	assert.deepEqual(seen.sort(), [0, 1, 2])
	assert.deepEqual(
		await mapConcurrent([], 4, async () => {
			throw new Error('must not run')
		}),
		[]
	)
})

test('createFileData copies template fields instead of sharing them', () => {
	const parsedSettings = createParsedSettings(3)
	parsedSettings.template.fields = { Front: 'q' }
	const fileData = createFileData(parsedSettings, 'Default', ['review'])

	assert.deepEqual(fileData.template.fields, { Front: 'q' })
	assert.notStrictEqual(fileData.template.fields, parsedSettings.template.fields)
	fileData.template.fields['Front'] = 'mutated'
	assert.equal(parsedSettings.template.fields['Front'], 'q')
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

test('pruneFileHashes drops only records whose path no longer exists', () => {
	const hashes = {
		'kept.md': { hash: 'a', mtime: 1, size: 1, noteIds: [1] },
		'deleted.md': { hash: 'b', mtime: 1, size: 1, noteIds: [2] },
		'legacy-gone.md': 'old-string-hash'
	}
	const removed = pruneFileHashes(hashes, (path) => path === 'kept.md')

	assert.equal(removed, 2)
	assert.deepEqual(Object.keys(hashes), ['kept.md'])
})

test('pruneFileHashes leaves a fully valid map untouched', () => {
	const hashes = { 'a.md': 'x', 'b.md': 'y' }
	assert.equal(
		pruneFileHashes(hashes, () => true),
		0
	)
	assert.deepEqual(Object.keys(hashes), ['a.md', 'b.md'])
})

test('createYielder pauses only once the scan has held the thread for the budget', async () => {
	let clock = 1000
	const yieldIfDue = createYielder(16, () => clock)

	clock += 15
	assert.equal(await yieldIfDue(), false)
	clock += 1
	assert.equal(await yieldIfDue(), true)
	// The budget counts again from the pause.
	clock += 15
	assert.equal(await yieldIfDue(), false)
	clock += 1
	assert.equal(await yieldIfDue(), true)
})

test('createYielder lets pending timers run when it pauses', async () => {
	let clock = 0
	const yieldIfDue = createYielder(16, () => clock)
	let ran = false
	setTimeout(() => {
		ran = true
	}, 0)

	clock = 16
	await yieldIfDue()

	assert.equal(ran, true)
})

test('createYielder defaults to a frame on the real clock', async () => {
	assert.equal(FRAME_BUDGET_MS, 16)
	const yieldIfDue = createYielder()
	assert.equal(await yieldIfDue(), false)
	await new Promise((resolve) => setTimeout(resolve, 20))
	assert.equal(await yieldIfDue(), true)
})
