const ANKI_PORT: number = 8765

import { requestUrl } from 'obsidian'
import { AnkiConnectNote } from './interfaces/note-interface'

export class AnkiConnectError extends Error {
	constructor(
		public action: string,
		public ankiError: string
	) {
		super(`AnkiConnect [${action}]: ${ankiError}`)
		this.name = 'AnkiConnectError'
	}
}

export interface AnkiTransport {
	invoke<T = unknown>(action: string, params?: Record<string, unknown>): Promise<T>
}

export function buildPayload(action: string, params: Record<string, unknown>, apiKey = ''): Record<string, unknown> {
	if (apiKey) {
		return { action, version: 6, params, key: apiKey }
	}
	return { action, version: 6, params }
}

export interface PermissionResult {
	permission: string
	requireApiKey?: boolean
	requireApikey?: boolean
	version?: number
}

export function requiresApiKey(result: PermissionResult): boolean {
	return result.requireApiKey ?? result.requireApikey ?? false
}

export function connectionMessage(result: PermissionResult, hasKey: boolean): { ok: boolean; message: string } {
	if (result.permission !== 'granted') {
		return { ok: false, message: 'Anki denied permission. Check the AnkiConnect webCorsOriginList.' }
	}
	if (requiresApiKey(result) && !hasKey) {
		return {
			ok: false,
			message: 'AnkiConnect requires an API key. Set it in the plugin settings (Anki API Key).'
		}
	}
	const version = result.version ?? 'unknown'
	return { ok: true, message: `Connected to AnkiConnect (version ${version}).` }
}

export class ObsidianRequestUrlTransport implements AnkiTransport {
	constructor(
		private port: number = ANKI_PORT,
		private apiKey = ''
	) {}

	async invoke<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T> {
		try {
			const res = await requestUrl({
				url: 'http://127.0.0.1:' + this.port.toString(),
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(buildPayload(action, params, this.apiKey))
			})
			const data = res.json
			if (data.error) {
				throw new AnkiConnectError(action, data.error)
			}
			return data.result as T
		} catch (e) {
			if (e instanceof AnkiConnectError) throw e
			throw new Error(`Failed to connect to Anki: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
		}
	}
}

export class FetchTransport implements AnkiTransport {
	constructor(
		private port: number = ANKI_PORT,
		private apiKey = ''
	) {}

	async invoke<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T> {
		try {
			const res = await fetch('http://127.0.0.1:' + this.port.toString(), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(buildPayload(action, params, this.apiKey))
			})
			const data = await res.json()
			if (data.error) {
				throw new AnkiConnectError(action, data.error)
			}
			return data.result as T
		} catch (e) {
			if (e instanceof AnkiConnectError) throw e
			throw new Error(`Failed to connect to Anki: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
		}
	}
}

let activeTransport: AnkiTransport = new ObsidianRequestUrlTransport()

export function setTransport(transport: AnkiTransport): void {
	activeTransport = transport
}

export interface AnkiConnectRequest {
	action: string
	version: 6
	params: Record<string, unknown>
}

export function invoke<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T> {
	return activeTransport.invoke<T>(action, params)
}

export function parse<T>(response: { error: string | null; result: T }): T {
	// Helper function for parsing the result of a multi
	if (response.error) {
		throw new AnkiConnectError('parse', response.error)
	}
	return response.result
}

// All the rest of these functions only return request objects as opposed to actually carrying out the action. For efficiency!

function request(action: string, params: Record<string, unknown> = {}): AnkiConnectRequest {
	return { action, version: 6, params }
}

export function multi(actions: AnkiConnectRequest[]): AnkiConnectRequest {
	return request('multi', { actions: actions })
}

export function addNote(note: AnkiConnectNote): AnkiConnectRequest {
	return request('addNote', { note: note })
}

export function createDeck(deck: string): AnkiConnectRequest {
	return request('createDeck', { deck: deck })
}

export function deleteNotes(note_ids: number[]): AnkiConnectRequest {
	return request('deleteNotes', { notes: note_ids })
}

export function updateNoteFields(id: number, fields: Record<string, string>): AnkiConnectRequest {
	return request('updateNoteFields', {
		note: {
			id: id,
			fields: fields
		}
	})
}

export function notesInfo(note_ids: number[]): AnkiConnectRequest {
	return request('notesInfo', {
		notes: note_ids
	})
}

export function changeDeck(card_ids: number[], deck: string): AnkiConnectRequest {
	return request('changeDeck', {
		cards: card_ids,
		deck: deck
	})
}

export function updateNoteTags(note_id: number, tags: string[]): AnkiConnectRequest {
	return request('updateNoteTags', {
		note: note_id,
		tags: tags
	})
}

export function getTags(): AnkiConnectRequest {
	return request('getTags')
}

export function requestPermission(): AnkiConnectRequest {
	return request('requestPermission')
}

export function sync(): AnkiConnectRequest {
	return request('sync')
}

export function guiBrowse(query: string): AnkiConnectRequest {
	return request('guiBrowse', { query })
}

export function guiEditNote(noteId: number): AnkiConnectRequest {
	return request('guiEditNote', { note: noteId })
}

export function updateNote(id: number, fields: Record<string, string>, tags: string[]): AnkiConnectRequest {
	return request('updateNote', { note: { id, fields, tags } })
}

export interface ApiReflectResult {
	scopes: string[]
	actions?: string[]
}

/**
 * Ask the running AnkiConnect which of the given actions it supports.
 *
 * Late actions such as `updateNote` shipped without bumping the frozen API
 * version (still 6), so `version` cannot gate them. `apiReflect` reports the
 * action list of the live daemon. Any failure degrades to the empty set,
 * which routes callers onto the legacy, always-supported code paths.
 */
export async function detectSupportedActions(actions: string[]): Promise<Set<string>> {
	try {
		const result = await invoke<ApiReflectResult>('apiReflect', { scopes: ['actions'], actions })
		return new Set(Array.isArray(result.actions) ? result.actions : [])
	} catch (_e) {
		return new Set()
	}
}

export function storeMediaFile(filename: string, data: string): AnkiConnectRequest {
	return request('storeMediaFile', {
		filename: filename,
		data: data
	})
}

export function storeMediaFileByPath(filename: string, path: string): AnkiConnectRequest {
	return request('storeMediaFile', {
		filename: filename,
		path: path
	})
}
