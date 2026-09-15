import { Notice, Plugin, addIcon, TFile, TFolder, Editor } from 'obsidian'
import * as AnkiConnect from './src/anki'
import { PluginSettings, ParsedSettings, StoredPluginData } from './src/interfaces/settings-interface'
import { DEFAULT_IGNORED_FILE_GLOBS, SettingsTab } from './src/settings'
import { ANKI_ICON } from './src/constants'
import { settingToData } from './src/setting-to-data'
import { FileManager, ScanCancelledError, type ScanControl } from './src/files-manager'
import { FileHashes, extractNoteIdFromLine, findFirstNoteId } from './src/scan-optimizations'
import { collectDryRunState, formatDryRunSummary } from './src/dry-run'
import { launchAnki, probeAnkiStatus } from './src/anki-launch'

export default class MyPlugin extends Plugin {
	declare settings: PluginSettings
	note_types: Array<string> = []
	fields_dict: Record<string, string[]> = {}
	added_media: string[] = []
	file_hashes: FileHashes = {}
	scan_in_progress: boolean = false
	schedule_id?: number

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
			Defaults: {
				'Scan Directories': [],
				Tag: 'Obsidian_to_Anki',
				Deck: 'Default',
				'Scheduling Interval': 0,
				'Add File Link': false,
				'Add Context': false,
				CurlyCloze: false,
				'CurlyCloze - Highlights to Clozes': false,
				'ID Comments': true,
				'Add Obsidian Tags': false,
				'Anki API Key': '',
				'Sync to AnkiWeb': false,
				'Delete Removed Notes': true,
				'Allow Note Type Changes': false,
				'Auto-launch Anki': false
			},
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
			return default_sets
		} else {
			return current_data.settings
		}
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
	 * Recursively traverse a TFolder and return all TFiles.
	 * @param tfolder - The TFolder to start the traversal from.
	 * @returns An array of TFiles found within the folder and its subfolders.
	 */
	getAllTFilesInFolder(tfolder: TFolder): TFile[] {
		const allTFiles: TFile[] = []
		// Check if the provided object is a TFolder
		if (!(tfolder instanceof TFolder)) {
			return allTFiles
		}
		// Iterate through the contents of the folder
		tfolder.children.forEach((child) => {
			// If it's a TFile, add it to the result
			if (child instanceof TFile) {
				allTFiles.push(child)
			} else if (child instanceof TFolder) {
				// If it's a TFolder, recursively call the function on it
				const filesInSubfolder = this.getAllTFilesInFolder(child)
				allTFiles.push(...filesInSubfolder)
			}
			// Ignore other types of files or objects
		})
		return allTFiles
	}

	async scanVault(file?: TFile | null, control: ScanControl = {}) {
		if (this.scan_in_progress) {
			new Notice('A vault scan is already in progress.')
			return
		}

		this.scan_in_progress = true
		try {
			await this.scanVaultOnce(file, false, control)
		} finally {
			this.scan_in_progress = false
		}
	}

	/**
	 * Format the end-of-scan counts for humans (Notices) — the machine-readable
	 * twin is the `[Obsidian_to_Anki] scan complete:` console one-liner below.
	 */
	private formatScanNotice(changed: number, total: number, added: number, updated: number, deleted: number): string {
		return `Scan complete: +${added} ~${updated} -${deleted} (${changed}/${total} files)`
	}

	async scanVaultOnce(file?: TFile | null, dryRun = false, control: ScanControl = {}) {
		console.info('Checking connection to Anki...')
		const probe = await probeAnkiStatus()
		console.info(`[Obsidian_to_Anki] anki status: ${probe.status}`)
		if (probe.status === 'ready') {
			new Notice(`Scanning vault (${dryRun ? 'dry-run' : 'sync'})...`)
		} else if (probe.status === 'closed' && this.isAutoLaunchEnabled()) {
			const outcome = await launchAnki(true)
			if (outcome === 'launched-and-ready') {
				new Notice('Anki is now running. Continuing the scan...')
			} else {
				new Notice('Anki is starting in the background. Run the scan again in a few seconds.')
				return
			}
		} else {
			new Notice(probe.message)
			return
		}
		const data: ParsedSettings = await settingToData(this.app, this.settings, this.fields_dict)
		const scanDirs = this.settings.Defaults['Scan Directories']
		let manager = null
		if (file !== undefined && file !== null) {
			manager = new FileManager(this.app, data, [file], this.file_hashes, this.added_media)
		} else if (scanDirs && scanDirs.length > 0) {
			const markdownFiles = []
			for (const dirPath of scanDirs) {
				const scanDir = this.app.vault.getAbstractFileByPath(dirPath)
				if (scanDir instanceof TFolder) {
					console.info('Using custom scan directory: ' + scanDir.path)
					markdownFiles.push(...this.getAllTFilesInFolder(scanDir))
				} else {
					new Notice('Error: incorrect path for scan directory ' + dirPath)
				}
			}
			manager = new FileManager(this.app, data, markdownFiles, this.file_hashes, this.added_media)
		} else {
			manager = new FileManager(
				this.app,
				data,
				this.app.vault.getMarkdownFiles(),
				this.file_hashes,
				this.added_media
			)
		}
		const totalFiles = manager.files.length
		try {
			await manager.initialiseFiles(control)
		} catch (error) {
			if (error instanceof ScanCancelledError) {
				console.info('[Obsidian_to_Anki] scan cancelled by user.')
				new Notice('Scan cancelled.')
				return
			}
			throw error
		}
		if (manager.ownFiles.length === 0) {
			new Notice('No changed files found. Nothing to sync.')
			console.info('No changed files found. Nothing to sync.')
			return
		}
		if (dryRun) {
			await this.reportDryRun(manager, totalFiles)
			return
		}
		await manager.requests_1()
		// Structured one-liner for CLI agents and log scraping:
		// [Obsidian_to_Anki] scan complete: files_changed=2/120 added=5 updated=1 deleted=0
		const added = manager.ownFiles.reduce((n, f) => n + f.all_notes_to_add.length, 0)
		const updated = manager.ownFiles.reduce((n, f) => n + f.notes_to_edit.length, 0)
		const deleted = manager.ownFiles.reduce((n, f) => n + f.notes_to_delete.length, 0)
		console.info(
			`[Obsidian_to_Anki] scan complete: files_changed=${manager.ownFiles.length}/${totalFiles} added=${added} updated=${updated} deleted=${deleted}`
		)
		new Notice(this.formatScanNotice(manager.ownFiles.length, totalFiles, added, updated, deleted))
		this.added_media = Array.from(manager.added_media_set)
		const hashes = manager.getHashes()
		for (const key in hashes) {
			this.file_hashes[key] = hashes[key]
		}
		this.saveAllData()
	}

	/**
	 * Read-only preview path: same file discovery and parsing as a real scan,
	 * but collects the diff via collectDryRunState instead of dispatching the
	 * mutating batch. Never writes files, hashes or media state.
	 */
	async reportDryRun(manager: FileManager, totalFiles: number): Promise<void> {
		const summary = await collectDryRunState(manager.ownFiles, {
			hasNoteTypeChanges: manager.data.allow_note_type_changes,
			orphanNoteIds: manager.orphanNoteIds,
			orphanFileById: manager.orphanFileById()
		})
		summary.filesTotal = totalFiles
		console.info(formatDryRunSummary(summary))
		console.info('[Obsidian_to_Anki] dry-run details: ' + JSON.stringify(summary.changes))
		new Notice(
			`Dry-run: +${summary.wouldAdd} ~${summary.wouldUpdate} -${summary.wouldDelete} ` +
				`convert ${summary.wouldConvert} (nothing written, see console)`
		)
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

		this.addRibbonIcon('anki', 'Obsidian_to_Anki - Scan Vault', async () => {
			await this.scanVault(undefined)
		})

		this.addCommand({
			id: 'anki-scan-vault',
			name: 'Scan Vault',
			callback: async () => {
				await this.scanVault(undefined)
			}
		})

		this.addCommand({
			id: 'anki-scan-file',
			name: 'Scan Current File',
			callback: async () => {
				await this.scanVault(this.app.workspace.getActiveFile())
			}
		})

		this.addCommand({
			id: 'anki-dry-run',
			name: 'Dry Run (preview changes without writing)',
			callback: async () => {
				if (this.scan_in_progress) {
					new Notice('A vault scan is already in progress.')
					return
				}
				this.scan_in_progress = true
				try {
					await this.scanVaultOnce(undefined, true)
				} finally {
					this.scan_in_progress = false
				}
			}
		})

		this.addCommand({
			id: 'anki-view-in-browser',
			name: 'View Note in Anki Browser',
			editorCallback: async (editor: Editor) => {
				await this.openNoteInAnki(editor, 'browse')
			}
		})

		this.addCommand({
			id: 'anki-edit-note',
			name: 'Edit Note in Anki',
			editorCallback: async (editor: Editor) => {
				await this.openNoteInAnki(editor, 'edit')
			}
		})
	}

	async openNoteInAnki(editor: Editor, mode: 'browse' | 'edit'): Promise<void> {
		const cursorLine = editor.getLine(editor.getCursor().line)
		const noteId = extractNoteIdFromLine(cursorLine) ?? findFirstNoteId(editor.getValue())
		if (noteId === null) {
			new Notice('No Anki note ID found in the active file.')
			return
		}
		try {
			if (mode === 'browse') {
				await AnkiConnect.invoke('guiBrowse', { query: `nid:${noteId}` })
			} else {
				await AnkiConnect.invoke('guiEditNote', { note: noteId })
			}
		} catch (_e) {
			new Notice("Couldn't connect to Anki! Check console for error message.")
		}
	}

	async onunload() {
		console.log('Saving settings for Obsidian_to_Anki...')
		this.saveAllData()
		console.log('unloading Obsidian_to_Anki...')
	}
}
