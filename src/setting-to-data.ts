import { PluginSettings, ParsedSettings } from './interfaces/settings-interface'
import { App } from 'obsidian'
import * as AnkiConnect from './anki'
import { ID_REGEXP_STR } from './note'
import { escapeRegex } from './constants'

/**
 * Everything the scan pipeline needs, derived from stored settings plus the
 * live Anki note list. Built as a single object literal (no partial-cast
 * placeholder), so a missing field is a compile error instead of an
 * undefined at scan time.
 */
export async function settingToData(
	app: App,
	settings: PluginSettings,
	fields_dict: Record<string, string[]>
): Promise<ParsedSettings> {
	const existingIds = await AnkiConnect.invoke<number[]>('findNotes', { query: '' })

	return {
		// Some processing required
		vault_name: app.vault.getName(),
		fields_dict,
		custom_regexps: settings.CUSTOM_REGEXPS,
		file_link_fields: settings.FILE_LINK_FIELDS,
		context_fields: settings.CONTEXT_FIELDS,
		folder_decks: settings.FOLDER_DECKS,
		folder_tags: settings.FOLDER_TAGS,
		template: {
			deckName: settings.Defaults.Deck,
			modelName: '',
			fields: {},
			options: {
				allowDuplicate: true
			},
			tags: [settings.Defaults.Tag]
		},
		EXISTING_IDS: new Set(existingIds),

		// RegExp section
		FROZEN_REGEXP: new RegExp(
			escapeRegex(settings.Syntax['Frozen Fields Line']) + String.raw` - (.*?):\n((?:[^\n][\n]?)+)`,
			'g'
		),
		DECK_REGEXP: new RegExp(
			String.raw`^` + escapeRegex(settings.Syntax['Target Deck Line']) + String.raw`(?:\n|: )(.*)`,
			'm'
		),
		TAG_REGEXP: new RegExp(
			String.raw`^` + escapeRegex(settings.Syntax['File Tags Line']) + String.raw`(?:\n|: )(.*)`,
			'm'
		),
		NOTE_REGEXP: new RegExp(
			String.raw`^` +
				escapeRegex(settings.Syntax['Begin Note']) +
				String.raw`[ ]*\n([\s\S]*?\n)` +
				escapeRegex(settings.Syntax['End Note']) +
				String.raw`[ ]*`,
			'gm'
		),
		INLINE_REGEXP: new RegExp(
			escapeRegex(settings.Syntax['Begin Inline Note']) +
				String.raw`(.*?)` +
				escapeRegex(settings.Syntax['End Inline Note']),
			'g'
		),
		EMPTY_REGEXP: new RegExp(escapeRegex(settings.Syntax['Delete Note Line']) + ID_REGEXP_STR, 'g'),

		// Just a simple transfer
		curly_cloze: settings.Defaults.CurlyCloze,
		highlights_to_cloze: settings.Defaults['CurlyCloze - Highlights to Clozes'],
		add_file_link: settings.Defaults['Add File Link'],
		comment: settings.Defaults['ID Comments'],
		add_context: settings.Defaults['Add Context'],
		add_obs_tags: settings.Defaults['Add Obsidian Tags'],
		sync_to_ankiweb: settings.Defaults['Sync to AnkiWeb'] ?? false,
		delete_removed_notes: settings.Defaults['Delete Removed Notes'] ?? true,
		allow_note_type_changes: settings.Defaults['Allow Note Type Changes'] ?? false,
		ignored_file_globs: settings.IGNORED_FILE_GLOBS ?? []
	}
}
