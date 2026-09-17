import { describe, it, expect, vi } from 'vitest'
import type { Editor } from 'obsidian'
import * as AnkiConnect from '../../src/anki'
import { openNoteInAnki } from '../../src/commands'
import { extractNoteIdFromLine, findFirstNoteId } from '../../src/scan-optimizations'

describe('gui commands: note ID resolution', () => {
	it('extracts plain and commented IDs from a line', () => {
		expect(extractNoteIdFromLine('ID: 1514547547030')).toBe(1514547547030)
		expect(extractNoteIdFromLine('<!--ID: 42-->')).toBe(42)
		expect(extractNoteIdFromLine('Back: some answer')).toBeNull()
		expect(extractNoteIdFromLine('# Heading')).toBeNull()
	})

	it('finds the first ID in file content', () => {
		const content = 'START\nBasic\nFront: Q\nBack: A\n<!--ID: 111-->\nEND\n\nSTART\nBasic\n<!--ID: 222-->\nEND'
		expect(findFirstNoteId(content)).toBe(111)
		expect(findFirstNoteId('no ids here\njust text')).toBeNull()
	})
})

describe('gui commands: AnkiConnect builders', () => {
	it('guiBrowse builds a query request', () => {
		expect(AnkiConnect.guiBrowse('nid:1514547547030')).toEqual({
			action: 'guiBrowse',
			version: 6,
			params: { query: 'nid:1514547547030' }
		})
	})

	it('guiEditNote builds a note request', () => {
		expect(AnkiConnect.guiEditNote(1514547547030)).toEqual({
			action: 'guiEditNote',
			version: 6,
			params: { note: 1514547547030 }
		})
	})

	it('requestPermission and sync builders produce keyless actions', () => {
		expect(AnkiConnect.requestPermission()).toEqual({
			action: 'requestPermission',
			version: 6,
			params: {}
		})
		expect(AnkiConnect.sync()).toEqual({ action: 'sync', version: 6, params: {} })
	})

	it('getTags builder produces a paramless action', () => {
		expect(AnkiConnect.getTags()).toEqual({ action: 'getTags', version: 6, params: {} })
	})

	it('openNoteInAnki invokes guiBrowse with the resolved ID', async () => {
		const invokeSpy = vi.spyOn(AnkiConnect, 'invoke').mockResolvedValue(null)
		const notify = vi.fn()
		const editor = {
			getLine: () => '<!--ID: 777-->',
			getCursor: () => ({ line: 0 }),
			getValue: () => ''
		} as unknown as Editor

		await openNoteInAnki({ invoke: invokeSpy, notify }, editor, 'browse')
		expect(invokeSpy).toHaveBeenCalledWith('guiBrowse', { query: 'nid:777' })

		await openNoteInAnki({ invoke: invokeSpy, notify }, editor, 'edit')
		expect(invokeSpy).toHaveBeenCalledWith('guiEditNote', { note: 777 })
		expect(notify).not.toHaveBeenCalled()
		vi.restoreAllMocks()
	})
})
