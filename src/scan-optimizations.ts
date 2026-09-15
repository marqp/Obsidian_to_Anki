import { Md5 } from 'ts-md5'
import type { FileData, ParsedSettings } from './interfaces/settings-interface'

export const VAULT_SCAN_YIELD_INTERVAL = 100

export interface FileHashEntry {
	hash: string
	mtime?: number
	size?: number
}

export type FileHashes = Record<string, string | FileHashEntry>

export function getFileContentHash(content: string): string {
	return Md5.hashStr(content) as string
}

export function getStoredHash(entry: string | FileHashEntry | undefined): string | undefined {
	if (!entry) return undefined
	return typeof entry === 'string' ? entry : entry.hash
}

/**
 * Fast-path negative check: returns true ONLY if mtime AND size match the cache.
 * If true, the file content cannot have changed, avoiding disk reads entirely.
 */
export function isStatUnchanged(
	stat: { mtime: number; size: number } | undefined,
	cachedEntry: string | FileHashEntry | undefined
): boolean {
	if (!stat || !cachedEntry || typeof cachedEntry === 'string') {
		return false
	}
	return cachedEntry.mtime === stat.mtime && cachedEntry.size === stat.size
}

export function isFileUnchanged(path: string, content: string, fileHashes: FileHashes): boolean {
	if (!Object.prototype.hasOwnProperty.call(fileHashes, path)) {
		return false
	}
	const storedHash = getStoredHash(fileHashes[path])
	return storedHash !== undefined && getFileContentHash(content) === storedHash
}

/**
 * Executes an async mapper function with bounded concurrency.
 */
export async function mapConcurrent<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	if (items.length === 0) return []
	const limit = Math.max(1, Math.min(concurrency, items.length))
	const results: R[] = new Array(items.length)
	let nextIndex = 0

	const workers = Array.from({ length: limit }, async () => {
		while (nextIndex < items.length) {
			const current = nextIndex++
			results[current] = await fn(items[current], current)
		}
	})

	await Promise.all(workers)
	return results
}

/**
 * Build the small amount of state that differs per file while sharing the
 * read-only dictionaries, regular expressions, and Anki note ID set.
 */
export function createFileData(data: ParsedSettings, deckName: string, tags: string[]): FileData {
	return {
		fields_dict: data.fields_dict,
		custom_regexps: data.custom_regexps,
		file_link_fields: data.file_link_fields,
		context_fields: data.context_fields,
		template: {
			...data.template,
			deckName,
			fields: { ...data.template.fields },
			options: { ...data.template.options },
			tags: [...tags]
		},
		EXISTING_IDS: data.EXISTING_IDS,
		vault_name: data.vault_name,
		FROZEN_REGEXP: data.FROZEN_REGEXP,
		DECK_REGEXP: data.DECK_REGEXP,
		TAG_REGEXP: data.TAG_REGEXP,
		NOTE_REGEXP: data.NOTE_REGEXP,
		INLINE_REGEXP: data.INLINE_REGEXP,
		EMPTY_REGEXP: data.EMPTY_REGEXP,
		curly_cloze: data.curly_cloze,
		highlights_to_cloze: data.highlights_to_cloze,
		comment: data.comment,
		add_context: data.add_context,
		add_obs_tags: data.add_obs_tags
	}
}

export async function yieldToEventLoop(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0))
}
