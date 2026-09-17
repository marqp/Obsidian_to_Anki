import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Editor } from 'obsidian'
import {
	openNoteInAnki,
	registerPluginCommands,
	resolveNoteId,
	type CommandRegistrar,
	type PluginCommandHandlers
} from '../../src/commands'

function makeEditor(line: string, value: string): Editor {
	return {
		getLine: () => line,
		getCursor: () => ({ line: 0 }),
		getValue: () => value
	} as unknown as Editor
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe('resolveNoteId', () => {
	it('prefers the cursor line over the file content', () => {
		expect(resolveNoteId('ID: 5', '<!--ID: 9-->')).toBe(5)
	})

	it('falls back to the first ID in the file', () => {
		expect(resolveNoteId('Back: answer', 'START <!--ID: 9--> END')).toBe(9)
	})

	it('returns null when no ID exists', () => {
		expect(resolveNoteId('Back: answer', 'no ids here')).toBeNull()
	})
})

describe('openNoteInAnki', () => {
	it('opens the browser for the resolved ID', async () => {
		const invoke = vi.fn().mockResolvedValue(null)
		const notify = vi.fn()
		await openNoteInAnki({ invoke, notify }, makeEditor('<!--ID: 777-->', ''), 'browse')
		expect(invoke).toHaveBeenCalledWith('guiBrowse', { query: 'nid:777' })
		expect(notify).not.toHaveBeenCalled()
	})

	it('edits the note for the resolved ID', async () => {
		const invoke = vi.fn().mockResolvedValue(null)
		const notify = vi.fn()
		await openNoteInAnki({ invoke, notify }, makeEditor('no id here', 'text <!--ID: 888-->'), 'edit')
		expect(invoke).toHaveBeenCalledWith('guiEditNote', { note: 888 })
		expect(notify).not.toHaveBeenCalled()
	})

	it('notifies when no note ID is found', async () => {
		const invoke = vi.fn()
		const notify = vi.fn()
		await openNoteInAnki({ invoke, notify }, makeEditor('Back: answer', 'no ids'), 'browse')
		expect(invoke).not.toHaveBeenCalled()
		expect(notify).toHaveBeenCalledWith('No Anki note ID found in the active file.')
	})

	it('notifies when Anki is unreachable', async () => {
		const invoke = vi.fn().mockRejectedValue(new Error('offline'))
		const notify = vi.fn()
		await openNoteInAnki({ invoke, notify }, makeEditor('<!--ID: 1-->', ''), 'browse')
		expect(notify).toHaveBeenCalledWith("Couldn't connect to Anki! Check console for error message.")
	})
})

describe('registerPluginCommands', () => {
	function makeRegistrar(): CommandRegistrar & {
		ribbons: Array<{ icon: string; title: string; callback: () => void }>
		commands: Array<{
			id: string
			name: string
			callback?: () => void
			editorCallback?: (editor: Editor) => void
		}>
	} {
		const ribbons: Array<{ icon: string; title: string; callback: () => void }> = []
		const commands: Array<{
			id: string
			name: string
			callback?: () => void
			editorCallback?: (editor: Editor) => void
		}> = []
		return {
			ribbons,
			commands,
			addRibbonIcon: (icon: string, title: string, callback: () => void) => {
				ribbons.push({ icon, title, callback })
				return {}
			},
			addCommand: (command: {
				id: string
				name: string
				callback?: () => void
				editorCallback?: (editor: Editor) => void
			}) => {
				commands.push(command)
				return {}
			}
		}
	}

	it('registers the ribbon and all six commands with stable ids', () => {
		const registrar = makeRegistrar()
		const handlers: PluginCommandHandlers = {
			onScanVault: vi.fn(),
			onScanFile: vi.fn(),
			onDryRun: vi.fn(),
			onPreviewSync: vi.fn(),
			onOpenNote: vi.fn()
		}
		registerPluginCommands(registrar, handlers)
		expect(registrar.ribbons.map((r) => [r.icon, r.title])).toEqual([['anki', 'Obsidian_to_Anki - Scan Vault']])
		expect(registrar.commands.map((c) => [c.id, c.name])).toEqual([
			['anki-scan-vault', 'Scan Vault'],
			['anki-scan-file', 'Scan Current File'],
			['anki-dry-run', 'Dry Run (preview changes without writing)'],
			['anki-preview-sync', 'Preview Sync (confirm in modal before writing)'],
			['anki-view-in-browser', 'View Note in Anki Browser'],
			['anki-edit-note', 'Edit Note in Anki']
		])
	})

	it('wires each command to its handler', () => {
		const registrar = makeRegistrar()
		const handlers: PluginCommandHandlers = {
			onScanVault: vi.fn(),
			onScanFile: vi.fn(),
			onDryRun: vi.fn(),
			onPreviewSync: vi.fn(),
			onOpenNote: vi.fn()
		}
		registerPluginCommands(registrar, handlers)
		registrar.ribbons[0].callback()
		registrar.commands[0].callback?.()
		registrar.commands[1].callback?.()
		registrar.commands[2].callback?.()
		registrar.commands[3].callback?.()
		const editor = makeEditor('', '')
		registrar.commands[4].editorCallback?.(editor)
		registrar.commands[5].editorCallback?.(editor)
		expect(handlers.onScanVault).toHaveBeenCalledTimes(2)
		expect(handlers.onScanFile).toHaveBeenCalledTimes(1)
		expect(handlers.onDryRun).toHaveBeenCalledTimes(1)
		expect(handlers.onPreviewSync).toHaveBeenCalledTimes(1)
		expect(handlers.onOpenNote).toHaveBeenCalledWith(editor, 'browse')
		expect(handlers.onOpenNote).toHaveBeenCalledWith(editor, 'edit')
	})
})
