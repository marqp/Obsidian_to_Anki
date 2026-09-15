import { describe, it, expect, vi } from 'vitest'
import * as AnkiConnect from '../../src/anki'
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

	it('openNoteInAnki invokes guiBrowse with the resolved ID', async () => {
		const invokeSpy = vi.spyOn(AnkiConnect, 'invoke').mockResolvedValue(null)
		// Exercise the resolution + dispatch contract without importing main.ts
		// (its bundle imports the real 'obsidian' module at load time).
		async function openNoteInAnki(
			editor: { getLine: (line: number) => string; getCursor: () => { line: number }; getValue: () => string },
			mode: 'browse' | 'edit'
		): Promise<number | null> {
			const cursorLine = editor.getLine(editor.getCursor().line)
			const noteId = extractNoteIdFromLine(cursorLine) ?? findFirstNoteId(editor.getValue())
			if (noteId === null) {
				return null
			}
			if (mode === 'browse') {
				await AnkiConnect.invoke('guiBrowse', { query: `nid:${noteId}` })
			} else {
				await AnkiConnect.invoke('guiEditNote', { note: noteId })
			}
			return noteId
		}
		const editor = {
			getLine: () => '<!--ID: 777-->',
			getCursor: () => ({ line: 0 }),
			getValue: () => ''
		}

		await openNoteInAnki(editor, 'browse')
		expect(invokeSpy).toHaveBeenCalledWith('guiBrowse', { query: 'nid:777' })

		await openNoteInAnki(editor, 'edit')
		expect(invokeSpy).toHaveBeenCalledWith('guiEditNote', { note: 777 })
		vi.restoreAllMocks()
	})
})
