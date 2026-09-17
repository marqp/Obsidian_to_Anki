import type { Editor } from 'obsidian'
import { extractNoteIdFromLine, findFirstNoteId } from './scan-optimizations'

/** Resolve the Anki note ID for the editor commands: cursor line first, then file. */
export function resolveNoteId(cursorLine: string, fileValue: string): number | null {
	return extractNoteIdFromLine(cursorLine) ?? findFirstNoteId(fileValue)
}

export interface NoteOpenerDeps {
	invoke(action: string, params?: Record<string, unknown>): Promise<unknown>
	notify(message: string): void
}

/** "View in Browser" / "Edit Note" command body (Wave 3: moved verbatim from main.ts). */
export async function openNoteInAnki(deps: NoteOpenerDeps, editor: Editor, mode: 'browse' | 'edit'): Promise<void> {
	const cursorLine = editor.getLine(editor.getCursor().line)
	const noteId = resolveNoteId(cursorLine, editor.getValue())
	if (noteId === null) {
		deps.notify('No Anki note ID found in the active file.')
		return
	}
	try {
		if (mode === 'browse') {
			await deps.invoke('guiBrowse', { query: `nid:${noteId}` })
		} else {
			await deps.invoke('guiEditNote', { note: noteId })
		}
	} catch {
		deps.notify("Couldn't connect to Anki! Check console for error message.")
	}
}

export interface PluginCommandHandlers {
	onScanVault(): void | Promise<void>
	onScanFile(): void | Promise<void>
	onDryRun(): void | Promise<void>
	onOpenNote(editor: Editor, mode: 'browse' | 'edit'): void | Promise<void>
}

/** Minimal surface of Obsidian Plugin used for command registration. */
export interface CommandRegistrar {
	addCommand(command: {
		id: string
		name: string
		callback?: () => void
		editorCallback?: (editor: Editor) => void
	}): unknown
	addRibbonIcon(icon: string, title: string, callback: () => void): unknown
}

/** Register the ribbon icon and all five plugin commands (ids/names unchanged). */
export function registerPluginCommands(registrar: CommandRegistrar, handlers: PluginCommandHandlers): void {
	registrar.addRibbonIcon('anki', 'Obsidian_to_Anki - Scan Vault', () => {
		void handlers.onScanVault()
	})

	registrar.addCommand({
		id: 'anki-scan-vault',
		name: 'Scan Vault',
		callback: () => {
			void handlers.onScanVault()
		}
	})

	registrar.addCommand({
		id: 'anki-scan-file',
		name: 'Scan Current File',
		callback: () => {
			void handlers.onScanFile()
		}
	})

	registrar.addCommand({
		id: 'anki-dry-run',
		name: 'Dry Run (preview changes without writing)',
		callback: () => {
			void handlers.onDryRun()
		}
	})

	registrar.addCommand({
		id: 'anki-view-in-browser',
		name: 'View Note in Anki Browser',
		editorCallback: (editor: Editor) => {
			void handlers.onOpenNote(editor, 'browse')
		}
	})

	registrar.addCommand({
		id: 'anki-edit-note',
		name: 'Edit Note in Anki',
		editorCallback: (editor: Editor) => {
			void handlers.onOpenNote(editor, 'edit')
		}
	})
}
