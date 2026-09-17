import { App, TFile, TFolder } from 'obsidian'
import { settingToData } from './setting-to-data'
import { FileManager, ScanCancelledError, type ScanControl } from './files-manager'
import { collectDryRunState, formatDryRunSummary, type DryRunSummary } from './dry-run'
import { launchAnki, probeAnkiStatus, type AnkiProbe, type LaunchOutcome } from './anki-launch'
import { obsidianNoticePort, type NoticePort } from './notices'
import type { ParsedSettings, PluginSettings } from './interfaces/settings-interface'
import type { FileHashes } from './scan-optimizations'

/** Live plugin state the scan reads; results are written back via commitScanResults. */
export interface ScanState {
	settings: PluginSettings
	fieldsDict: Record<string, string[]>
	fileHashes: FileHashes
	addedMedia: string[]
}

/**
 * Callbacks for the interactive preview modal. Exactly one fires per session;
 * the modal (not the orchestrator) guarantees this, including X/Escape
 * dismissal which counts as cancel. A missing opener falls back to the
 * legacy notice preview, so headless flows never hang on UI.
 */
export interface PreviewCallbacks {
	onConfirm(): void
	onCancel(): void
}

/** Result of the read-only preview pass shared by dry-run and the modal. */
export type ScanPreview =
	| { status: 'aborted' }
	| { status: 'empty' }
	| { status: 'ready'; summary: DryRunSummary; commit: () => Promise<void> }

/**
 * Everything the scan pipeline needs from the outside world. Production
 * wiring is createScanEnvironment(); tests inject fakes per field.
 */
export interface ScanEnvironment {
	app: App
	notices: NoticePort
	loadState(): ScanState
	/** Persist media + hashes after a successful sync (plugin-owned write). */
	commitScanResults(addedMedia: string[], hashes: FileHashes): void
	probeAnki(): Promise<AnkiProbe>
	isAutoLaunchEnabled(): boolean
	launchAnki(enabled: boolean): Promise<LaunchOutcome>
	toData(app: App, settings: PluginSettings, fieldsDict: Record<string, string[]>): Promise<ParsedSettings>
	createManager(app: App, data: ParsedSettings, files: TFile[], hashes: FileHashes, media: string[]): FileManager
	/** 'Confirm Before Sync' setting (default off); unattended paths bypass. */
	shouldConfirmSync: () => boolean
	/** Interactive preview opener; unset keeps the legacy notice preview. */
	openPreviewModal?: (summary: DryRunSummary, callbacks: PreviewCallbacks) => void
}

/** Production environment; loadState/commitScanResults stay plugin-owned. */
export function createScanEnvironment(
	app: App,
	state: { loadState(): ScanState; commitScanResults(addedMedia: string[], hashes: FileHashes): void },
	options: {
		isAutoLaunchEnabled(): boolean
		shouldConfirmSync(): boolean
		openPreviewModal?: (summary: DryRunSummary, callbacks: PreviewCallbacks) => void
	}
): ScanEnvironment {
	return {
		app,
		notices: obsidianNoticePort,
		loadState: state.loadState,
		commitScanResults: state.commitScanResults,
		probeAnki: () => probeAnkiStatus(),
		isAutoLaunchEnabled: options.isAutoLaunchEnabled,
		shouldConfirmSync: options.shouldConfirmSync,
		openPreviewModal: options.openPreviewModal,
		launchAnki: (enabled) => launchAnki(enabled),
		toData: (appArg, settings, fieldsDict) => settingToData(appArg, settings, fieldsDict),
		createManager: (appArg, data, files, hashes, media) => new FileManager(appArg, data, files, hashes, media)
	}
}

/**
 * Format the end-of-scan counts for humans (Notices) — the machine-readable
 * twin is the `[Obsidian_to_Anki] scan complete:` console one-liner below.
 */
export function formatScanNotice(
	changed: number,
	total: number,
	added: number,
	updated: number,
	deleted: number
): string {
	return `Scan complete: +${added} ~${updated} -${deleted} (${changed}/${total} files)`
}

/**
 * Recursively traverse a TFolder and return all TFiles.
 * @param tfolder - The TFolder to start the traversal from.
 * @returns An array of TFiles found within the folder and its subfolders.
 */
export function getAllTFilesInFolder(tfolder: TFolder): TFile[] {
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
			const filesInSubfolder = getAllTFilesInFolder(child)
			allTFiles.push(...filesInSubfolder)
		}
		// Ignore other types of files or objects
	})
	return allTFiles
}

/**
 * Scan pipeline extracted from the plugin class (Wave 3): connection probe,
 * file discovery, FileManager passes, dry-run preview, and the mutating sync.
 * Owns the scan-in-progress guard; all Obsidian/Anki I/O goes through env.
 */
export class ScanOrchestrator {
	private scanInProgress = false

	constructor(private readonly env: ScanEnvironment) {}

	async scanVault(file?: TFile | null, control: ScanControl = {}, opts: { bypassConfirm?: boolean } = {}) {
		if (!opts.bypassConfirm && this.env.shouldConfirmSync()) {
			await this.runPreviewSync(file, control)
			return
		}
		if (this.scanInProgress) {
			this.env.notices.notify('A vault scan is already in progress.')
			return
		}

		this.scanInProgress = true
		try {
			await this.scanVaultOnce(file, false, control)
		} finally {
			this.scanInProgress = false
		}
	}

	/** Dry-run command path: same guard as scanVault, read-only pipeline. */
	async runDryRun(control: ScanControl = {}): Promise<void> {
		if (this.scanInProgress) {
			this.env.notices.notify('A vault scan is already in progress.')
			return
		}

		this.scanInProgress = true
		try {
			await this.scanVaultOnce(undefined, true, control)
		} finally {
			this.scanInProgress = false
		}
	}

	async scanVaultOnce(file?: TFile | null, dryRun = false, control: ScanControl = {}): Promise<void> {
		if (!(await this.checkConnection(dryRun))) {
			return
		}
		const { manager, totalFiles } = await this.prepareManager(file)
		try {
			await manager.initialiseFiles(control)
		} catch (error) {
			if (error instanceof ScanCancelledError) {
				console.info('[Obsidian_to_Anki] scan cancelled by user.')
				this.env.notices.notify('Scan cancelled.')
				return
			}
			throw error
		}
		if (manager.ownFiles.length === 0) {
			this.env.notices.notify('No changed files found. Nothing to sync.')
			console.info('No changed files found. Nothing to sync.')
			return
		}
		if (dryRun) {
			await this.reportDryRun(manager, totalFiles)
			return
		}
		await this.commitManagerResults(manager, totalFiles)
	}

	/**
	 * Shared read-only preview: probe, discovery, parse, diff — no writes.
	 * The returned commit runs the mutating tail over the same manager.
	 * Cancellation propagates as ScanCancelledError for the caller to report.
	 */
	async previewScan(file?: TFile | null, control: ScanControl = {}): Promise<ScanPreview> {
		if (!(await this.checkConnection(true))) {
			return { status: 'aborted' }
		}
		const { manager, totalFiles } = await this.prepareManager(file)
		await manager.initialiseFiles(control)
		if (manager.ownFiles.length === 0) {
			return { status: 'empty' }
		}
		const summary = await collectDryRunState(manager.ownFiles, {
			hasNoteTypeChanges: manager.data.allow_note_type_changes,
			orphanNoteIds: manager.orphanNoteIds,
			orphanFileById: manager.orphanFileById()
		})
		summary.filesTotal = totalFiles
		return { status: 'ready', summary, commit: () => this.commitManagerResults(manager, totalFiles) }
	}

	/**
	 * Interactive preview path: same guard as scanVault, modal (or legacy
	 * notice preview when no opener is wired) instead of a direct sync. The
	 * guard is held while the modal is open and released by exactly one of
	 * the modal callbacks, so a concurrent scan waits instead of racing it.
	 */
	async runPreviewSync(file?: TFile | null, control: ScanControl = {}): Promise<void> {
		if (this.scanInProgress) {
			this.env.notices.notify('A vault scan is already in progress.')
			return
		}
		this.scanInProgress = true
		let preview: ScanPreview
		try {
			preview = await this.previewScan(file, control)
		} catch (error) {
			this.scanInProgress = false
			if (error instanceof ScanCancelledError) {
				console.info('[Obsidian_to_Anki] scan cancelled by user.')
				this.env.notices.notify('Scan cancelled.')
				return
			}
			throw error
		}
		if (preview.status === 'aborted') {
			this.scanInProgress = false
			return
		}
		if (preview.status === 'empty') {
			this.scanInProgress = false
			this.env.notices.notify('No changed files found. Nothing to sync.')
			console.info('No changed files found. Nothing to sync.')
			return
		}
		const openModal = this.env.openPreviewModal
		if (!openModal) {
			this.scanInProgress = false
			this.emitDryRunPreview(preview.summary)
			return
		}
		const commit = preview.commit
		await new Promise<void>((resolve) => {
			openModal(preview.summary, {
				onConfirm: () => {
					void commit().then(
						() => {
							this.scanInProgress = false
							resolve()
						},
						(error: unknown) => {
							console.error('[Obsidian_to_Anki] sync failed after confirm:', error)
							this.env.notices.notify('Sync failed. Check console for details.')
							this.scanInProgress = false
							resolve()
						}
					)
				},
				onCancel: () => {
					this.scanInProgress = false
					resolve()
				}
			})
		})
	}

	/** Probe + file discovery shared by the sync and preview paths. */
	private async checkConnection(dryRun: boolean): Promise<boolean> {
		const { notices } = this.env
		console.info('Checking connection to Anki...')
		const probe = await this.env.probeAnki()
		console.info(`[Obsidian_to_Anki] anki status: ${probe.status}`)
		if (probe.status === 'ready') {
			notices.notify(`Scanning vault (${dryRun ? 'dry-run' : 'sync'})...`)
			return true
		}
		if (probe.status === 'closed' && this.env.isAutoLaunchEnabled()) {
			const outcome = await this.env.launchAnki(true)
			if (outcome === 'launched-and-ready') {
				notices.notify('Anki is now running. Continuing the scan...')
				return true
			}
			notices.notify('Anki is starting in the background. Run the scan again in a few seconds.')
			return false
		}
		notices.notify(probe.message)
		return false
	}

	private async prepareManager(file?: TFile | null): Promise<{ manager: FileManager; totalFiles: number }> {
		const { notices } = this.env
		const state = this.env.loadState()
		const data: ParsedSettings = await this.env.toData(this.env.app, state.settings, state.fieldsDict)
		const scanDirs = state.settings.Defaults['Scan Directories']
		let manager: FileManager
		if (file !== undefined && file !== null) {
			manager = this.env.createManager(this.env.app, data, [file], state.fileHashes, state.addedMedia)
		} else if (scanDirs && scanDirs.length > 0) {
			const markdownFiles: TFile[] = []
			for (const dirPath of scanDirs) {
				const scanDir = this.env.app.vault.getAbstractFileByPath(dirPath)
				if (scanDir instanceof TFolder) {
					console.info('Using custom scan directory: ' + scanDir.path)
					markdownFiles.push(...getAllTFilesInFolder(scanDir))
				} else {
					notices.notify('Error: incorrect path for scan directory ' + dirPath)
				}
			}
			manager = this.env.createManager(this.env.app, data, markdownFiles, state.fileHashes, state.addedMedia)
		} else {
			manager = this.env.createManager(
				this.env.app,
				data,
				this.env.app.vault.getMarkdownFiles(),
				state.fileHashes,
				state.addedMedia
			)
		}
		return { manager, totalFiles: manager.files.length }
	}

	/** Mutating tail shared by direct sync and modal confirm. */
	private async commitManagerResults(manager: FileManager, totalFiles: number): Promise<void> {
		await manager.requests_1()
		// Structured one-liner for CLI agents and log scraping:
		// [Obsidian_to_Anki] scan complete: files_changed=2/120 added=5 updated=1 deleted=0
		// NOTE: totalFiles is captured before initialiseFiles narrows
		// manager.files down to the changed files — do not recompute it here.
		const added = manager.ownFiles.reduce((n, f) => n + f.all_notes_to_add.length, 0)
		const updated = manager.ownFiles.reduce((n, f) => n + f.notes_to_edit.length, 0)
		const deleted = manager.ownFiles.reduce((n, f) => n + f.notes_to_delete.length, 0)
		console.info(
			`[Obsidian_to_Anki] scan complete: files_changed=${manager.ownFiles.length}/${totalFiles} added=${added} updated=${updated} deleted=${deleted}`
		)
		this.env.notices.notify(formatScanNotice(manager.ownFiles.length, totalFiles, added, updated, deleted))
		this.env.commitScanResults(Array.from(manager.added_media_set), manager.getHashes())
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
		this.emitDryRunPreview(summary)
	}

	/**
	 * Legacy notice preview (headless dry-run + modal-less fallback). Strings
	 * are the CLI contract — the interactive modal renders its own copy.
	 */
	private emitDryRunPreview(summary: DryRunSummary): void {
		console.info(formatDryRunSummary(summary))
		console.info('[Obsidian_to_Anki] dry-run details: ' + JSON.stringify(summary.changes))
		this.env.notices.notify(
			`Dry-run: +${summary.wouldAdd} ~${summary.wouldUpdate} -${summary.wouldDelete} ` +
				`convert ${summary.wouldConvert} (nothing written, see console)`
		)
	}
}
