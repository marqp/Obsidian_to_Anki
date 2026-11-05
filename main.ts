import { Notice, Plugin, TFile, addIcon } from 'obsidian'
import * as AnkiConnect from './src/anki'
import { PluginSettings, StoredPluginData } from './src/interfaces/settings-interface'
import { DEFAULT_IGNORED_FILE_GLOBS, SettingsTab } from './src/settings'
import { ANKI_ICON } from './src/constants'
import { FileHashes, createFileData, pruneFileHashes } from './src/scan-optimizations'
import { applyImport, previewImport, type ImportOptions, type ImportResult, type ImportVault } from './src/anki-import'
import { settingToData } from './src/setting-to-data'
import { migrateSettings } from './src/ui/settings-migration'
import { buildDefaults } from './src/defaults-meta'
import {
	ScanOrchestrator,
	createScanEnvironment,
	type PreviewCallbacks,
	type ScanReport
} from './src/scan-orchestrator'
import { openNoteInAnki, registerPluginCommands } from './src/commands'
import { obsidianNoticePort } from './src/notices'
import { createProgressNotice } from './src/progress-notice'
import { describeConnectionFailure, probeAnkiStatus } from './src/anki-launch'
import { LocalApiServer, MIN_TOKEN_LENGTH, generateToken, type ApiHandlers, pathForms } from './src/api-server'
import {
	collectionMetadata,
	difficultCards,
	getNotes,
	readOcclusionNotes,
	searchNotes,
	studyOverview,
	type SourceLookup
} from './src/anki-read'
import type { DryRunSummary } from './src/dry-run'
import { pullOcclusions, type PullDependencies } from './src/occlusion-pull'
import { DryRunModal } from './src/ui/dry-run-modal'
import { type ScanControl } from './src/files-manager'

const CACHE_WAIT_MS = 100
const CACHE_WAIT_ATTEMPTS = 50

export default class MyPlugin extends Plugin {
	declare settings: PluginSettings
	note_types: Array<string> = []
	fields_dict: Record<string, string[]> = {}
	added_media: string[] = []
	file_hashes: FileHashes = {}
	schedule_id?: number
	private apiServer?: LocalApiServer
	private apiTimer?: number
	/** Serialises start/stop so rapid setting changes never race on the port. */
	private apiQueue: Promise<void> = Promise.resolve()
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
		// First run only when there are no stored settings at all; a missing
		// auxiliary key must never wipe the user's settings (the other
		// loaders default their own sections).
		if (current_data == null || typeof current_data.settings !== 'object' || current_data.settings === null) {
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
		return current_data.fields_dict ?? {}
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
	 * this); UI commands go straight to the orchestrator. Always direct —
	 * unattended scans must never open a modal. Thin delegation.
	 */
	async scanVault(file?: TFile | null, control: ScanControl = {}): Promise<ScanReport> {
		return await this.scanOrchestrator().scanVault(file, control, { bypassConfirm: true })
	}

	/** Read-only preview of what a sync would do; same guard as a real scan. */
	async dryRun(file?: TFile | null): Promise<ScanReport> {
		return await this.scanOrchestrator().runDryRun({}, file)
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
							pruneFileHashes(
								this.file_hashes,
								(path) => this.app.vault.getAbstractFileByPath(path) !== null
							)
							this.saveAllData()
						}
					},
					{
						isAutoLaunchEnabled: () => this.isAutoLaunchEnabled(),
						shouldConfirmSync: () => this.isConfirmBeforeSync(),
						openPreviewModal: (summary, callbacks) => this.openPreviewModal(summary, callbacks),
						createProgress: () => createProgressNotice()
					}
				)
			)
		}
		return this.orchestrator
	}

	private isConfirmBeforeSync(): boolean {
		return this.settings['Defaults']['Confirm Before Sync'] === true
	}

	private openPreviewModal(summary: DryRunSummary, callbacks: PreviewCallbacks): void {
		new DryRunModal(this.app, summary, callbacks).open()
	}

	/**
	 * (Re)start the auto-scan timer from the 'Scheduling Interval' default
	 * (minutes, 0 = off). Called on load and whenever the slider changes;
	 * registerInterval ensures Obsidian clears it on unload.
	 */
	startSchedule(): void {
		if (this.schedule_id !== undefined) {
			window.clearInterval(this.schedule_id)
			this.schedule_id = undefined
		}
		const minutes = this.settings.Defaults['Scheduling Interval']
		if (minutes > 0) {
			this.schedule_id = window.setInterval(() => void this.scanVault(), minutes * 60 * 1000)
			this.registerInterval(this.schedule_id)
		}
	}

	/** Vault file for an API-supplied path, or null when it is not a file. */
	private apiFile(path: string): TFile | null {
		for (const form of pathForms(path)) {
			const file = this.app.vault.getAbstractFileByPath(form)
			if (file instanceof TFile) {
				return file
			}
		}
		return null
	}

	/** Vault file of each tracked note, as of each file's last scan. */
	private noteSourceLookup(): SourceLookup {
		const fileById = new Map<number, string>()
		for (const [path, entry] of Object.entries(this.file_hashes)) {
			if (typeof entry !== 'string') {
				for (const id of entry.noteIds ?? []) {
					fileById.set(id, path)
				}
			}
		}
		return (noteId) => fileById.get(noteId)
	}

	/** Every note ID written in the vault, scanned folder or not, so nothing gets imported twice. */
	private async idsInVault(): Promise<Set<number>> {
		const ids = new Set<number>()
		for (const file of this.app.vault.getMarkdownFiles()) {
			for (const match of (await this.app.vault.cachedRead(file)).matchAll(/ID: (\d+)/g)) {
				ids.add(parseInt(match[1], 10))
			}
		}
		return ids
	}

	private importVault(): ImportVault {
		const { vault, metadataCache, fileManager } = this.app
		return {
			createNote: async (path, text) => {
				const folder = path.slice(0, path.lastIndexOf('/'))
				if (folder !== '' && vault.getAbstractFileByPath(folder) === null) {
					await vault.createFolder(folder)
				}
				const file = await vault.create(path, text)
				// A scan reads embeds from this cache: without them `![[a.png]]` would reach Anki as text.
				for (let wait = 0; metadataCache.getFileCache(file) === null && wait < CACHE_WAIT_ATTEMPTS; wait++) {
					await new Promise((resolve) => window.setTimeout(resolve, CACHE_WAIT_MS))
				}
			},
			readAttachment: async (name) => {
				const file = metadataCache.getFirstLinkpathDest(name, '')
				return file === null ? null : await vault.readBinary(file)
			},
			createAttachment: async (name, data) => {
				await vault.createBinary(await fileManager.getAvailablePathForAttachment(name), data)
			}
		}
	}

	/** Line starts the block parser reads as structure. */
	private reservedWords(): string[] {
		const { Syntax: syntax } = this.settings
		return [
			syntax['Begin Note'],
			syntax['End Note'],
			syntax['Target Deck Line'],
			syntax['File Tags Line'],
			syntax['Frozen Fields Line'],
			syntax['Delete Note Line'],
			'Tags: ',
			...new Set(
				Object.values(this.fields_dict)
					.flat()
					.map((field) => `${field}:`)
			)
		]
	}

	private async pullDependencies(): Promise<PullDependencies> {
		const { vault, metadataCache } = this.app
		const { Defaults: defaults, Syntax: syntax } = this.settings
		const data = await settingToData(this.app, this.settings, this.fields_dict)
		const fileAt = (path: string): TFile | null => this.apiFile(path)
		return {
			isScanning: () => this.scanOrchestrator().isScanning,
			readNotes: readOcclusionNotes,
			sourceOf: this.noteSourceLookup(),
			read: async (path) => {
				const file = fileAt(path)
				return file === null ? null : await vault.read(file)
			},
			cache: (path) => {
				const file = fileAt(path)
				return (file === null ? null : metadataCache.getFileCache(file)) ?? {}
			},
			process: async (path, edit) => {
				const file = fileAt(path)
				if (file !== null) {
					await vault.process(file, edit)
				}
			},
			data: createFileData(data, defaults.Deck, []),
			syntax: {
				beginNote: syntax['Begin Note'],
				endNote: syntax['End Note'],
				reservedWords: this.reservedWords(),
				otherLabels: [
					'Tags: ',
					...(this.fields_dict['Image Occlusion'] ?? [])
						.filter((field) => field !== 'Occlusion')
						.map((field) => `${field}:`)
				]
			}
		}
	}

	private async importOptions(subjects?: Record<string, string>): Promise<ImportOptions> {
		const { Defaults: defaults, Syntax: syntax } = this.settings
		const data = await settingToData(this.app, this.settings, this.fields_dict)
		const scanned = defaults['Scan Directories'][0] ?? ''
		return {
			folder: `${scanned === '' ? '' : `${scanned}/`}Importados`,
			defaultDeck: defaults.Deck,
			beginNote: syntax['Begin Note'],
			reservedWords: this.reservedWords(),
			dataFor: (deck) => createFileData(data, deck, []),
			pathExists: (path) => this.app.vault.getAbstractFileByPath(path) !== null,
			...(subjects === undefined
				? {}
				: { subjects: new Map(Object.entries(subjects).map(([id, subject]) => [parseInt(id, 10), subject])) })
		}
	}

	private apiHandlers(): ApiHandlers {
		return {
			status: () => probeAnkiStatus(),
			scan: () => this.scanVault(),
			scanFile: async (path) => {
				const file = this.apiFile(path)
				return file === null ? null : await this.scanVault(file)
			},
			dryRun: async (path) => {
				if (path === undefined) {
					return await this.dryRun()
				}
				const file = this.apiFile(path)
				return file === null ? null : await this.dryRun(file)
			},
			validate: async ({ path, content }) => {
				const orchestrator = this.scanOrchestrator()
				if (content !== undefined) {
					return await orchestrator.validate({ inline: { path: path ?? 'unsaved.md', text: content } })
				}
				if (path === undefined) {
					return await orchestrator.validate()
				}
				const file = this.apiFile(path)
				return file === null ? null : await orchestrator.validate({ file })
			},
			scanState: () => {
				const orchestrator = this.scanOrchestrator()
				const last = orchestrator.lastReport
				if (last === undefined) {
					return { inProgress: orchestrator.isScanning }
				}
				const { details: _details, ...lastReport } = last
				return { inProgress: orchestrator.isScanning, lastReport }
			},
			metadata: () => {
				const { Defaults: defaults, Syntax: syntax } = this.settings
				return collectionMetadata(this.fields_dict, {
					defaultDeck: defaults.Deck,
					curlyCloze: defaults.CurlyCloze,
					highlightsToCloze: defaults['CurlyCloze - Highlights to Clozes'],
					idComments: defaults['ID Comments'],
					deleteRemovedNotes: defaults['Delete Removed Notes'] ?? true,
					allowNoteTypeChanges: defaults['Allow Note Type Changes'] ?? false,
					syncToAnkiWeb: defaults['Sync to AnkiWeb'] ?? false,
					schedulingIntervalMinutes: defaults['Scheduling Interval'],
					scanDirectories: defaults['Scan Directories'] ?? [],
					syntax
				})
			},
			searchNotes: (search) => searchNotes(search, this.noteSourceLookup()),
			getNotes: (ids, raw) => getNotes(ids, raw, this.noteSourceLookup()),
			studyOverview: (deck, days) => studyOverview(deck, days),
			difficultCards: (query) => difficultCards(query, this.noteSourceLookup()),
			importPreview: async ({ query, subjects }) =>
				previewImport(await this.idsInVault(), await this.importOptions(subjects), query),
			importApply: async ({ query, subjects }): Promise<ImportResult> => {
				if (this.scanOrchestrator().isScanning) {
					return {
						blocked: ['A scan is running. Try again when it ends.'],
						filesWritten: [],
						notesWritten: 0,
						imagesCopied: 0,
						imagesAlreadyInVault: 0,
						refused: []
					}
				}
				return await applyImport(
					await this.idsInVault(),
					await this.importOptions(subjects),
					this.importVault(),
					query
				)
			},
			occlusionPull: async (request) => pullOcclusions(request, await this.pullDependencies())
		}
	}

	/**
	 * (Re)apply the Local API settings: stop any running server, then start
	 * one if enabled. Serialised through apiQueue; failures become a Notice.
	 */
	restartApiServer(): Promise<void> {
		this.apiQueue = this.apiQueue.then(() => this.applyApiSettings())
		return this.apiQueue
	}

	/** Debounced restart for text inputs (port/token fire per keystroke). */
	scheduleApiRestart(): void {
		if (this.apiTimer !== undefined) {
			window.clearTimeout(this.apiTimer)
		}
		this.apiTimer = window.setTimeout(() => {
			this.apiTimer = undefined
			void this.restartApiServer()
		}, 600)
	}

	private async applyApiSettings(): Promise<void> {
		await this.apiServer?.stop()
		this.apiServer = undefined
		const defaults = this.settings.Defaults
		if (defaults['Local API'] !== true) {
			return
		}
		const port = defaults['Local API Port']
		if (!Number.isInteger(port) || port < 1024 || port > 65535) {
			new Notice(`Local API not started: port must be 1024-65535 (got ${port}).`)
			return
		}
		let token = defaults['Local API Token']
		if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH) {
			token = generateToken()
			defaults['Local API Token'] = token
			await this.saveAllData()
		}
		const server = new LocalApiServer({ port, token, handlers: this.apiHandlers() })
		try {
			await server.start()
			this.apiServer = server
			console.info(`[Obsidian_to_Anki] local API listening on 127.0.0.1:${server.port}`)
		} catch (error) {
			console.error('[Obsidian_to_Anki] local API failed to start:', error)
			new Notice(
				`Local API could not start on port ${port}: ${error instanceof Error ? error.message : String(error)}`,
				10000
			)
		}
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
		} catch (e) {
			console.error('[Obsidian_to_Anki] failed to load plugin data:', e)
			new Notice(await describeConnectionFailure(), 10000)
			return
		}

		this.note_types = Object.keys(this.settings['CUSTOM_REGEXPS'])
		if (Object.keys(this.fields_dict).length == 0) {
			new Notice('Need to connect to Anki to generate fields dictionary...')
			try {
				this.fields_dict = await this.generateFieldsDict()
				new Notice('Fields dictionary successfully generated!')
			} catch (e) {
				// Non-fatal: settings are loaded, the dictionary is rebuilt
				// on demand (settings tab) once Anki is reachable. Commands
				// and the settings tab must still register.
				console.error('[Obsidian_to_Anki] could not generate fields dictionary:', e)
				new Notice(await describeConnectionFailure(), 10000)
			}
		}
		this.added_media = await this.loadAddedMedia(snapshot)
		this.file_hashes = await this.loadFileHashes(snapshot)
		this.syncTransportKey()

		this.addSettingTab(new SettingsTab(this.app, this))
		this.startSchedule()
		void this.restartApiServer()

		const orchestrator = this.scanOrchestrator()

		registerPluginCommands(this, {
			onScanVault: async () => {
				await orchestrator.scanVault(undefined)
			},
			onScanFile: async () => {
				await orchestrator.scanVault(this.app.workspace.getActiveFile())
			},
			onDryRun: async () => {
				await orchestrator.runDryRun()
			},
			onPreviewSync: () => orchestrator.runPreviewSync(undefined),
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
		if (this.apiTimer !== undefined) {
			window.clearTimeout(this.apiTimer)
			this.apiTimer = undefined
		}
		await this.apiQueue
		await this.apiServer?.stop()
		this.apiServer = undefined
		this.saveAllData()
	}
}
