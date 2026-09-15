import { FIELDS_DICT } from './field-interface'
import { AnkiConnectNote } from './note-interface'
import type { FileHashes } from '../scan-optimizations'

export interface PluginSettings {
	CUSTOM_REGEXPS: Record<string, string>
	FILE_LINK_FIELDS: Record<string, string>
	CONTEXT_FIELDS: Record<string, string>
	FOLDER_DECKS: Record<string, string>
	FOLDER_TAGS: Record<string, string>
	Syntax: {
		'Begin Note': string
		'End Note': string
		'Begin Inline Note': string
		'End Inline Note': string
		'Target Deck Line': string
		'File Tags Line': string
		'Delete Note Line': string
		'Frozen Fields Line': string
		[key: string]: string
	}
	Defaults: {
		'Scan Directories': string[]
		Tag: string
		Deck: string
		'Scheduling Interval': number
		'Add File Link': boolean
		'Add Context': boolean
		CurlyCloze: boolean
		'CurlyCloze - Highlights to Clozes': boolean
		'ID Comments': boolean
		'Add Obsidian Tags': boolean
		'Anki API Key': string
		'Sync to AnkiWeb': boolean
		'Delete Removed Notes': boolean
		'Allow Note Type Changes': boolean
		'Auto-launch Anki': boolean
		/** Legacy key, migrated to 'Scan Directories' on load and then deleted. */
		'Scan Directory'?: string
		[key: string]: string[] | string | number | boolean | undefined
	}
	IGNORED_FILE_GLOBS: string[]
}

/** Exact shape of the plugin's data.json on disk (one read per boot). */
export interface StoredPluginData {
	settings: PluginSettings
	'Added Media': string[]
	'File Hashes': FileHashes
	fields_dict: Record<string, string[]>
}

export interface FileData {
	//All the data that a file would need.
	fields_dict: FIELDS_DICT
	custom_regexps: Record<string, string>
	file_link_fields: Record<string, string>
	context_fields: Record<string, string>
	template: AnkiConnectNote
	EXISTING_IDS: ReadonlySet<number>
	vault_name: string

	FROZEN_REGEXP: RegExp
	DECK_REGEXP: RegExp
	TAG_REGEXP: RegExp
	NOTE_REGEXP: RegExp
	INLINE_REGEXP: RegExp
	EMPTY_REGEXP: RegExp

	curly_cloze: boolean
	highlights_to_cloze: boolean
	comment: boolean
	add_context: boolean
	add_obs_tags: boolean
}

export interface ParsedSettings extends FileData {
	add_file_link: boolean
	folder_decks: Record<string, string>
	folder_tags: Record<string, string>
	ignored_file_globs: string[]
	sync_to_ankiweb: boolean
	delete_removed_notes: boolean
	allow_note_type_changes: boolean
}
