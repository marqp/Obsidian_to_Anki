import { createHash } from 'crypto'

/** What the plugin knows about one media link, kept in data.json as `Media Records`. */
export interface MediaRecord {
	/** The vault file the link resolved to, so a new file of that name is never taken for it. */
	path: string
	/** SHA-256 of what Anki was last known to hold from this file; null when that is unknown. */
	hash: string | null
	mtime: number
	size: number
}

export type MediaRecords = Record<string, MediaRecord>

/**
 * Files compared with Anki per scan. Each costs a file read and a request, and
 * a vault with no records yet starts with every file it has ever sent.
 */
export const MEDIA_CHECKS_PER_SCAN = 100

export function hashBytes(bytes: ArrayBuffer | Uint8Array): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
	return createHash('sha256').update(view).digest('hex')
}
