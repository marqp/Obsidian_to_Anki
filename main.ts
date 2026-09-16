import { Notice, Plugin, addIcon } from 'obsidian'
import type { TFile } from 'obsidian'
import * as AnkiConnect from './src/anki'
import { PluginSettings, StoredPluginData } from './src/interfaces/settings-interface'
import { DEFAULT_IGNORED_FILE_GLOBS, SettingsTab } from './src/settings'
import { ANKI_ICON } from './src/constants'
import { FileHashes } from './src/scan-optimizations'
import { migrateSettings } from './src/ui/settings-migration'
import { buildDefaults } from './src/defaults-meta'
import { ScanOrchestrator, createScanEnvironment } from './src/scan-orchestrator'
import { openNoteInAnki, registerPluginCommands } from './src/commands'
import { obsidianNoticePort } from './src/notices'
import { type ScanControl } from './src/files-manager'

export default class MyPlugin extends Plugin {
	declare settings: PluginSettings
	note_types: Array<string> = []
	fields_dict: Record<string, string[]> = {}
	added_media: string[] = []
	file_hashes: FileHashes = {}
	schedule_id?: number
	private saveTimer?: number
	private orchestrator?: ScanOrchestrator

	async getDefaultSettings(): Promise<PluginSettings> {
		const settings: PluginSettings = {
			CUSTOM_REGEXPS: {},
			FILE_LINK_FIELDS: {},
			CONTEXT_FIELDS: {},
			FOLDER_DECKS: {},
			FOLDER_TAGS: {},
			Syntax: {
				'Begin Note': 'START',
				'End Note': 'END',
				'Begin Inline Note': 'STARTI',
				'End Inline Note': 'ENDI',
				'Target Deck Line': 'TARGET DECK',
				'File Tags Line': 'FILE TAGS',
				'Delete Note Line': 'DELETE',
				'Frozen Fields Line': 'FROZEN'
			},
			Defaults: buildDefaults() as PluginSettings['Defaults'],
			IGNORED_FILE_GLOBS: DEFAULT_IGNORED_FILE_GLOBS
		}
		/*Making settings from scratch, so need note types*/
		this.note_types = (await AnkiConnect.invoke('modelNames')) as Array<string>
		this.fields_dict = await this.generateFieldsDict()
		for (const note_type of this.note_types) {
			settings['CUSTOM_REGEXPS'][note_type] = ''
			// Reuse the already-fetched field names (a second modelFieldNames
			// round per model here tripled first-run AnkiConnect traffic).
			const field_names: string[] = this.fields_dict[note_type]
			settings['FILE_LINK_FIELDS'][note_type] = field_names[0]
		}
		return settings
	}

	async generateFieldsDict(): Promise<Record<string, string[]>> {
		const fields_dict: Record<string, string[]> = {}
		for (const note_type of this.note_types) {
			const field_names: string[] = (await AnkiConnect.invoke('modelFieldNames', {
				modelName: note_type
			})) as string[]
			fields_dict[note_type] = field_names
		}
		return fields_dict
	}

	async saveDefault(): Promise<void> {
		const default_sets = await this.getDefaultSettings()
		this.saveData({
			settings: default_sets,
			'Added Media': [],
			'File Hashes': {},
			fields_dict: {}
		})
	}

	async loadSettings(snapshot?: StoredPluginData | null): Promise<PluginSettings> {
		const current_data = snapshot === undefined ? ((await this.loadData()) as StoredPluginData | null) : snapshot
		if (current_data == null || Object.keys(current_data).length != 4) {
			new Notice('Need to connect to Anki generate default settings...')
			const default_sets = await this.getDefaultSettings()
			this.saveData({
				settings: default_sets,
				'Added Media': [],
				'File Hashes': {},
				fields_dict: {}
			})
			new Notice('Default settings successfully generated!')
			return migrateSettings(default_sets).settings
		}
		// Schema migration runs once here — never in the settings display
		// path. saveData (not saveAllData) so unloaded sections
		// (Added Media, File Hashes, fields_dict) are preserved verbatim.
		const { settings, dirty } = migrateSettings(current_data.settings)
		if (dirty) {
			await this.saveData({ ...current_data, settings })
		}
		return settings
	}

	async loadAddedMedia(snapshot?: StoredPluginData | null): Promise<string[]> {
		const current_data = snapshot === undefined ? ((await this.loadData()) as StoredPluginData | null) : snapshot
		if (current_data == null) {
			await this.saveDefault()
			return []
		} else {
			return current_data['Added Media'] ?? []
		}
	}

	async loadFileHashes(snapshot?: StoredPluginData | null): Promise<FileHashes> {
		const current_data = snapshot === undefined ? ((await this.loadData()) as StoredPluginData | null) : snapshot
		if (current_data == null) {
			await this.saveDefault()
			return {}
		} else {
			return current_data['File Hashes'] ?? {}
		}
	}

	async loadFieldsDict(snapshot?: StoredPluginData | null): Promise<Record<string, string[]>> {
		const current_data = snapshot === undefined ? ((await this.loadData()) as StoredPluginData | null) : snapshot
		if (current_data == null) {
			await this.saveDefault()
			// saveDefault() -> getDefaultSettings() already populated
			// this.fields_dict; re-fetching here tripled first-run traffic.
			return this.fields_dict
		}
		return current_data.fields_dict
	}

	async saveAllData(): Promise<void> {
		this.syncTransportKey()
		this.saveData({
			settings: this.settings,
			'Added Media': this.added_media,
			'File Hashes': this.file_hashes,
			fields_dict: this.fields_dict
		})
	}

	/**
	 * Debounced persist for high-frequency settings writers (every keystroke
	 * in a text field used to hit data.json). Explicit actions (scan end,
	 * buttons, migration) keep immediate saveAllData; the timer is cleared
	 * on unload, which always performs one final unconditional save.
	 */
	scheduleSave(): void {
		if (this.saveTimer !== undefined) {
			window.clearTimeout(this.saveTimer)
		}
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = undefined
			void this.saveAllData()
		}, 250)
	}

	syncTransportKey(): void {
		const configuredKey = this.settings['Defaults']['Anki API Key']
		const apiKey = typeof configuredKey === 'string' ? configuredKey : ''
		AnkiConnect.setTransport(new AnkiConnect.ObsidianRequestUrlTransport(8765, apiKey))
	}

	isAutoLaunchEnabled(): boolean {
		return this.settings['Defaults']['Auto-launch Anki'] === true
	}

	regenerateSettingsRegexps() {
		const regexp_section = this.settings['CUSTOM_REGEXPS']
		// For new note types
		for (const note_type of this.note_types) {
			this.settings['CUSTOM_REGEXPS'][note_type] = regexp_section.hasOwnProperty(note_type)
				? regexp_section[note_type]
				: ''
		}
		// Removing old note types
		for (const note_type of Object.keys(this.settings['CUSTOM_REGEXPS'])) {
			if (!this.note_types.includes(note_type)) {
				delete this.settings['CUSTOM_REGEXPS'][note_type]
			}
		}
	}

	/**
	 * Scheduled-scan entry point (the auto-scan scheduler in settings calls
	 * this); UI commands go straight to the orchestrator. Thin delegation —
	 * the pipeline lives in ScanOrchestrator.
	 */
	async scanVault(file?: TFile | null, control: ScanControl = {}): Promise<void> {
		await this.scanOrchestrator().scanVault(file, control)
	}

	private scanOrchestrator(): ScanOrchestrator {
		if (this.orchestrator === undefined) {
			this.orchestrator = new ScanOrchestrator(
				createScanEnvironment(
					this.app,
					{
						loadState: () => ({
							settings: this.settings,
							fieldsDict: this.fields_dict,
							fileHashes: this.file_hashes,
							addedMedia: this.added_media
						}),
						commitScanResults: (addedMedia, hashes) => {
							this.added_media = addedMedia
							for (const [key, entry] of Object.entries(hashes)) {
								this.file_hashes[key] = entry
							}
							this.saveAllData()
						}
					},
					{ isAutoLaunchEnabled: () => this.isAutoLaunchEnabled() }
				)
			)
		}
		return this.orchestrator
	}

	async onload() {
		console.log('loading Obsidian_to_Anki...')
		addIcon('anki', ANKI_ICON)

		let snapshot: StoredPluginData | null
		try {
			// Single data.json read per boot; the snapshot is threaded through
			// the loaders below instead of re-reading from disk each time.
			// Stale-snapshot risk: if loadSettings() falls back to saveDefault(),
			// the snapshot is refreshed from disk before the remaining loaders
			// run (first-run path only; steady state stays at 1 read).
			snapshot = (await this.loadData()) as StoredPluginData | null
			this.settings = await this.loadSettings(snapshot)
			if (snapshot == null) {
				snapshot = (await this.loadData()) as StoredPluginData | null
			}
			this.fields_dict = await this.loadFieldsDict(snapshot)
		} catch (_e) {
			new Notice("Couldn't connect to Anki! Check console for error message.")
			return
		}

		this.note_types = Object.keys(this.settings['CUSTOM_REGEXPS'])
		if (Object.keys(this.fields_dict).length == 0) {
			new Notice('Need to connect to Anki to generate fields dictionary...')
			try {
				this.fields_dict = await this.generateFieldsDict()
				new Notice('Fields dictionary successfully generated!')
			} catch (_e) {
				new Notice("Couldn't connect to Anki! Check console for error message.")
				return
			}
		}
		this.added_media = await this.loadAddedMedia(snapshot)
		this.file_hashes = await this.loadFileHashes(snapshot)
		this.syncTransportKey()

		this.addSettingTab(new SettingsTab(this.app, this))

		const orchestrator = this.scanOrchestrator()

		registerPluginCommands(this, {
			onScanVault: () => orchestrator.scanVault(undefined),
			onScanFile: () => orchestrator.scanVault(this.app.workspace.getActiveFile()),
			onDryRun: () => orchestrator.runDryRun(),
			onOpenNote: (editor, mode) =>
				openNoteInAnki(
					{
						invoke: (action, params) => AnkiConnect.invoke(action, params),
						notify: (m) => obsidianNoticePort.notify(m)
					},
					editor,
					mode
				)
		})
	}

	async onunload() {
		console.log('Saving settings for Obsidian_to_Anki...')
		if (this.saveTimer !== undefined) {
			window.clearTimeout(this.saveTimer)
			this.saveTimer = undefined
		}
		this.saveAllData()
	}
}
