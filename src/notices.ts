import { Notice } from 'obsidian'

/** Notice surface used by the scan; injectable so tests never touch the UI. */
export interface NoticePort {
	notify(message: string): void
}

/** Production NoticePort backed by the Obsidian Notice. */
export const obsidianNoticePort: NoticePort = { notify: (message) => new Notice(message) }
