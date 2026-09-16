/**
 * Single source of truth for the `Defaults` settings group: key, initial
 * value and the description shown in the settings UI. `main.ts` builds the
 * stored defaults from this list, `settings.ts` builds the descriptions,
 * and the migration fills anything missing from it — the settings UI,
 * `data.json` and `docs/config.md` can no longer drift from each other
 * (a unit test pins the doc table to this list).
 */
export interface DefaultMeta {
	key: string
	value: string[] | string | number | boolean
	description: string
}

export const DEFAULTS_META: DefaultMeta[] = [
	{
		key: 'Scan Directories',
		value: [],
		description: 'The directories to scan. Leave empty to scan the entire vault. One path per line.'
	},
	{
		key: 'Tag',
		value: 'Obsidian_to_Anki',
		description: 'The tag that the plugin automatically adds to any generated cards.'
	},
	{
		key: 'Deck',
		value: 'Default',
		description: 'The deck the plugin adds cards to if TARGET DECK is not specified in the file.'
	},
	{
		key: 'Scheduling Interval',
		value: 0,
		description:
			'The time, in minutes, between automatic scans of the vault. Set this to 0 to disable automatic scanning.'
	},
	{
		key: 'Add File Link',
		value: false,
		description: 'Append a link to the file that generated the flashcard on the field specified in the table.'
	},
	{
		key: 'Add Context',
		value: false,
		description:
			"Append 'context' for the card, in the form of path > heading > heading etc, to the field specified in the table."
	},
	{
		key: 'CurlyCloze',
		value: false,
		description:
			"Convert {cloze deletions} -> {{c1::cloze deletions}} on note types that have a 'Cloze' in their name."
	},
	{
		key: 'CurlyCloze - Highlights to Clozes',
		value: false,
		description: 'Convert ==highlights== -> {highlights} to be processed by CurlyCloze.'
	},
	{
		key: 'ID Comments',
		value: true,
		description: 'Wrap note IDs in a HTML comment.'
	},
	{
		key: 'Add Obsidian Tags',
		value: false,
		description: 'Interpret #tags in the fields of a note as Anki tags, removing them from the note text in Anki.'
	},
	{
		key: 'Anki API Key',
		value: '',
		description:
			'API key for AnkiConnect (only needed if you set apiKey in the AnkiConnect config). Stored in plaintext; only protects localhost access.'
	},
	{
		key: 'Sync to AnkiWeb',
		value: false,
		description: 'Trigger an AnkiWeb sync after each scan (requires AnkiWeb credentials in Anki desktop).'
	},
	{
		key: 'Allow Note Type Changes',
		value: false,
		description:
			'Convert notes in Anki when their note type changed in Markdown. Uses updateNoteModel; fields not present in the new note type are discarded by Anki, so review the change first. Off by default.'
	},
	{
		key: 'Delete Removed Notes',
		value: true,
		description:
			'Delete the Anki notes whose blocks were removed from Markdown. IDs are tracked per file; renames and moves between files are safe. The first scan of a file only records IDs, so nothing is deleted on that run.'
	},
	{
		key: 'Auto-launch Anki',
		value: false,
		description:
			'Launch Anki Desktop automatically when a scan finds it closed (desktop only, fire-and-forget). Off by default.'
	}
]

/** Fresh defaults object for `PluginSettings.Defaults` (arrays cloned). */
export function buildDefaults(): Record<string, string[] | string | number | boolean> {
	const defaults: Record<string, string[] | string | number | boolean> = {}
	for (const meta of DEFAULTS_META) {
		defaults[meta.key] = Array.isArray(meta.value) ? [...meta.value] : meta.value
	}
	return defaults
}
