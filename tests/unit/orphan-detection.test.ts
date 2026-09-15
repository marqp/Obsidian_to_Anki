import { describe, it, expect } from 'vitest'
import { AllFile } from '../../src/file'
import { createFileData, findOrphanedNoteIds } from '../../src/scan-optimizations'
import { createParsedSettings } from './anki-test-helpers'
import type { CachedMetadata } from 'obsidian'

function makeFile(content: string): AllFile {
	const data = createParsedSettings()
	return new AllFile(content, 'note.md', '', createFileData(data, 'Default', []), {} as CachedMetadata)
}

describe('AllFile.getNoteIdsInFile', () => {
	it('collects plain and commented IDs from blocks and inline notes', () => {
		const content = [
			'START',
			'Basic',
			'Front: q',
			'Back: a',
			'<!--ID: 111-->',
			'END',
			'',
			'STARTI[Basic] Front: inline Back: note ID: 222 ENDI'
		].join('\n')
		expect(makeFile(content).getNoteIdsInFile()).toEqual([111, 222])
	})

	it('excludes IDs consumed by a DELETE line', () => {
		const content = ['START', 'Basic', 'Front: q', 'Back: a', 'END', '', 'DELETE', 'ID: 333'].join('\n')
		expect(makeFile(content).getNoteIdsInFile()).toEqual([])
	})

	it('still counts block IDs when a DELETE line targets another note', () => {
		const content = [
			'START',
			'Basic',
			'Front: q',
			'Back: a',
			'<!--ID: 444-->',
			'END',
			'',
			'DELETE',
			'ID: 555'
		].join('\n')
		expect(makeFile(content).getNoteIdsInFile()).toEqual([444])
	})

	it('ignores IDs inside fenced code blocks', () => {
		const content = [
			'```',
			'<!--ID: 999-->',
			'```',
			'',
			'START',
			'Basic',
			'Front: q',
			'Back: a',
			'<!--ID: 111-->',
			'END'
		].join('\n')
		expect(makeFile(content).getNoteIdsInFile()).toEqual([111])
	})
})

describe('findOrphanedNoteIds', () => {
	const existing = new Set([1, 2, 3, 4])

	it('returns IDs that disappeared from a tracked file', () => {
		expect(findOrphanedNoteIds({ 'a.md': [1, 2] }, { 'a.md': [1] }, existing)).toEqual([2])
	})

	it('never deletes on first scan (no stored record)', () => {
		expect(findOrphanedNoteIds({}, { 'a.md': [] }, existing)).toEqual([])
	})

	it('never deletes for a renamed file (new path, no stored record)', () => {
		expect(findOrphanedNoteIds({ 'old.md': [1] }, { 'new.md': [] }, existing)).toEqual([])
	})

	it('keeps IDs still referenced by another changed file', () => {
		expect(findOrphanedNoteIds({ 'a.md': [1], 'b.md': [1] }, { 'a.md': [], 'b.md': [1] }, existing)).toEqual([])
	})

	it('keeps IDs stored in an unscanned file', () => {
		expect(findOrphanedNoteIds({ 'a.md': [1], 'other.md': [1] }, { 'a.md': [] }, existing)).toEqual([])
	})

	it('deletes when every referencing file dropped the ID', () => {
		expect(findOrphanedNoteIds({ 'a.md': [1], 'b.md': [1] }, { 'a.md': [], 'b.md': [] }, existing)).toEqual([1])
	})

	it('skips IDs that no longer exist in Anki', () => {
		expect(findOrphanedNoteIds({ 'a.md': [9] }, { 'a.md': [] }, existing)).toEqual([])
	})

	it('deduplicates orphans across files', () => {
		expect(findOrphanedNoteIds({ 'a.md': [2], 'b.md': [2] }, { 'a.md': [], 'b.md': [] }, existing)).toEqual([2])
	})
})
