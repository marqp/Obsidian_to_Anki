import { App, TFile, TFolder } from 'obsidian'
import { settingToData } from './setting-to-data'
import { FileManager, ScanCancelledError, type ScanControl, type ScanIssue } from './files-manager'
import type { MediaRecords } from './media-records'
import { NO_MEDIA_PLAN, type MediaPlan } from './media-sync'
import { collectDryRunState, formatDryRunSummary, type DryRunSummary } from './dry-run'
import { launchAnki, probeAnkiStatus, type AnkiProbe, type LaunchOutcome } from './anki-launch'
import { obsidianNoticePort, type NoticePort } from './notices'
import type { ScanProgressHandle } from './progress-notice'
import type { ParsedSettings, PluginSettings } from './interfaces/settings-interface'
import { createFileData, type FileHashes } from './scan-optimizations'
import { validateFiles, type ValidationReport } from './validate'

/** Live plugin state the scan reads; results are written back via commitScanResults. */
export interface ScanState {
	settings: PluginSettings
	fieldsDict: Record<string, string[]>
	fileHashes: FileHashes
	addedMedia: string[]
	mediaRecords: MediaRecords
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
	| { status: 'ready'; summary: DryRunSummary; commit: () => Promise<ScanReport> }

type ScanOutcome =
	| 'completed'
	| 'nothing-to-sync'
	| 'cancelled'
	/** Anki unreachable or not ready; `message` says why. */
	| 'aborted'
	/** Another scan holds the guard. */
	| 'busy'
	/** Confirm Before Sync is on: the preview modal now owns the decision. */
	| 'awaiting-confirmation'

/**
 * Structured result of one scan: the machine twin of the Notices and the
 * `scan complete:` console line, consumed by the local API.
 */
export interface ScanReport {
	outcome: ScanOutcome
	dryRun: boolean
	message?: string
	filesChanged: number
	filesTotal: number
	/** Real counts for a sync; the would-be counts for a dry-run. */
	added: number
	updated: number
	deleted: number
	/** Notes whose type was (or, in a dry-run, would be) converted. */
	converted: number
	/** Names of changed media files sent to Anki, or that a dry-run would send. */
	resentMedia: string[]
	issues: ScanIssue[]
	/** Dry-run only: per-note changes and per-deck stats. */
	details?: Pick<DryRunSummary, 'decks' | 'changes'>
}

function emptyReport(outcome: ScanOutcome, dryRun: boolean, message?: string): ScanReport {
	return {
		outcome,
		dryRun,
		message,
		filesChanged: 0,
		filesTotal: 0,
		added: 0,
		updated: 0,
		deleted: 0,
		converted: 0,
		resentMedia: [],
		issues: []
	}
}

/**
 * Everything the scan pipeline needs from the outside world. Production
 * wiring is createScanEnvironment(); tests inject fakes per field.
 */
export interface ScanEnvironment {
	app: App
	notices: NoticePort
	loadState(): ScanState
	/** Persist media + hashes after a successful sync (plugin-owned write). */
	commitScanResults(addedMedia: string[], hashes: FileHashes, mediaRecords: MediaRecords): void
	probeAnki(): Promise<AnkiProbe>
	isAutoLaunchEnabled(): boolean
	launchAnki(enabled: boolean): Promise<LaunchOutcome>
	toData(app: App, settings: PluginSettings, fieldsDict: Record<string, string[]>): Promise<ParsedSettings>
	createManager(app: App, data: ParsedSettings, files: TFile[], hashes: FileHashes, media: string[]): FileManager
	/** 'Confirm Before Sync' setting (default off); unattended paths bypass. */
	shouldConfirmSync: () => boolean
	/** Interactive preview opener; unset keeps the legacy notice preview. */
	openPreviewModal?: (summary: DryRunSummary, callbacks: PreviewCallbacks) => void
	/** Progress/cancel UI; unset (tests, headless) scans without one. */
	createProgress?: () => ScanProgressHandle
}

/** Production environment; loadState/commitScanResults stay plugin-owned. */
export function createScanEnvironment(
	app: App,
	state: Pick<ScanEnvironment, 'loadState' | 'commitScanResults'>,
	options: {
		isAutoLaunchEnabled(): boolean
		shouldConfirmSync(): boolean
		openPreviewModal?: (summary: DryRunSummary, callbacks: PreviewCallbacks) => void
		createProgress?: () => ScanProgressHandle
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
		createProgress: options.createProgress,
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
 * One line per problem for the end-of-scan Notice (first few only; the full
 * list is in the console). Returns null when the scan was clean.
 */
export function formatScanIssues(issues: ScanIssue[], maxShown = 3): string | null {
	if (issues.length === 0) {
		return null
	}
	const lines = issues.slice(0, maxShown).map((i) => `${i.file || 'batch'}: ${i.error}`)
	const more = issues.length > maxShown ? `\n...and ${issues.length - maxShown} more (see console)` : ''
	return `${issues.length} problem(s) during sync:\n${lines.join('\n')}${more}`
}

/** What a scan reads: one file, a list of files, or (null or omitted) the vault or its Scan Directories. */
export type ScanTarget = TFile | TFile[] | null

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

/** The Markdown files of a folder and its subfolders: the images and PDFs beside them hold no cards. */
export function markdownFilesIn(folder: TFolder): TFile[] {
	return getAllTFilesInFolder(folder).filter((file) => file.extension === 'md')
}

/**
 * Scan pipeline extracted from the plugin class (Wave 3): connection probe,
 * file discovery, FileManager passes, dry-run preview, and the mutating sync.
 * Owns the scan-in-progress guard; all Obsidian/Anki I/O goes through env.
 */
export class ScanOrchestrator {
	private scanInProgress = false
	private latestReport: ScanReport | undefined

	constructor(private readonly env: ScanEnvironment) {}

	get isScanning(): boolean {
		return this.scanInProgress
	}

	/**
	 * Runs a vault write that is not a scan, such as an import or a mask pull,
	 * under the scan guard, so no scan starts while it writes. Returns `busy()`
	 * instead when a scan is already running.
	 */
	async exclusive<T>(work: () => Promise<T>, busy: () => T): Promise<T> {
		if (this.scanInProgress) {
			return busy()
		}
		this.scanInProgress = true
		try {
			return await work()
		} finally {
			this.scanInProgress = false
		}
	}

	/** How the last scan or dry-run ended, for a caller that stopped waiting. */
	get lastReport(): ScanReport | undefined {
		return this.latestReport
	}

	async scanVault(
		file?: ScanTarget,
		control: ScanControl = {},
		opts: { bypassConfirm?: boolean } = {}
	): Promise<ScanReport> {
		if (!opts.bypassConfirm && this.env.shouldConfirmSync()) {
			await this.runPreviewSync(file, control)
			return emptyReport('awaiting-confirmation', false)
		}
		if (this.scanInProgress) {
			this.env.notices.notify('A vault scan is already in progress.')
			return emptyReport('busy', false, 'A vault scan is already in progress.')
		}

		this.scanInProgress = true
		try {
			this.latestReport = await this.scanVaultOnce(file, false, control)
			return this.latestReport
		} finally {
			this.scanInProgress = false
		}
	}

	/** Dry-run command path: same guard as scanVault, read-only pipeline. */
	async runDryRun(control: ScanControl = {}, file?: TFile | null): Promise<ScanReport> {
		if (this.scanInProgress) {
			this.env.notices.notify('A vault scan is already in progress.')
			return emptyReport('busy', true, 'A vault scan is already in progress.')
		}

		this.scanInProgress = true
		try {
			this.latestReport = await this.scanVaultOnce(file, true, control)
			return this.latestReport
		} finally {
			this.scanInProgress = false
		}
	}

	async scanVaultOnce(file?: ScanTarget, dryRun = false, control: ScanControl = {}): Promise<ScanReport> {
		const notReady = await this.checkConnection(dryRun)
		if (notReady !== null) {
			return emptyReport('aborted', dryRun, notReady)
		}
		const { manager, totalFiles } = await this.prepareManager(file)
		const progress = this.startProgress(control)
		try {
			// The progress UI brings its own control, so the flag is passed on by hand,
			// and only to a dry-run: a real scan must keep skipping unchanged files.
			const everyFile = dryRun && control.everyFile === true ? true : undefined
			await manager.initialiseFiles({ ...progress.control, everyFile })
		} catch (error) {
			if (error instanceof ScanCancelledError) {
				console.info('[Obsidian_to_Anki] scan cancelled by user.')
				this.env.notices.notify('Scan cancelled.')
				return { ...emptyReport('cancelled', dryRun), filesTotal: totalFiles }
			}
			throw error
		} finally {
			progress.close()
		}
		// Media belongs to the vault, not to some files: scanning files leaves it alone.
		const wholeVault = file === undefined || file === null
		if (dryRun) {
			const media = wholeVault ? await manager.planChangedMedia() : NO_MEDIA_PLAN
			if (manager.ownFiles.length === 0 && media.resent.length === 0 && media.issues.length === 0) {
				return this.reportNothingToSync(dryRun, totalFiles)
			}
			return await this.reportDryRun(manager, totalFiles, control.everyFile === true, media, control.includeDiff)
		}
		if (wholeVault) {
			await manager.refreshChangedMedia()
		}
		if (manager.ownFiles.length === 0) {
			return await this.commitMediaOnly(manager, totalFiles)
		}
		return await this.commitManagerResults(manager, totalFiles)
	}

	private reportNothingToSync(dryRun: boolean, totalFiles: number): ScanReport {
		this.env.notices.notify('No changed files found. Nothing to sync.')
		console.info('No changed files found. Nothing to sync.')
		return { ...emptyReport('nothing-to-sync', dryRun), filesTotal: totalFiles }
	}

	/**
	 * Tail of a scan where no note file changed. Only a resend gives AnkiWeb
	 * something new; a record alone is the plugin's own bookkeeping.
	 */
	private async commitMediaOnly(manager: FileManager, totalFiles: number): Promise<ScanReport> {
		const resent = manager.resentMedia
		if (resent.length > 0) {
			await manager.syncToAnkiWeb()
		}
		if (manager.mediaRecordsChanged) {
			this.env.commitScanResults(Array.from(manager.added_media_set), {}, manager.mediaRecords)
		}
		const issues = manager.scanIssues
		if (resent.length === 0 && issues.length === 0) {
			return this.reportNothingToSync(false, totalFiles)
		}
		this.notifyMediaResults(resent, issues)
		return {
			...emptyReport(resent.length > 0 ? 'completed' : 'nothing-to-sync', false),
			filesTotal: totalFiles,
			resentMedia: [...resent],
			issues: [...issues]
		}
	}

	private notifyMediaResults(resent: string[], issues: ScanIssue[]): void {
		if (resent.length > 0) {
			console.info(`[Obsidian_to_Anki] resent changed media: ${resent.join(', ')}`)
			this.env.notices.notify(`Sent ${resent.length} changed media file(s) to Anki.`)
		}
		const issuesNotice = formatScanIssues(issues)
		if (issuesNotice !== null) {
			this.env.notices.notify(issuesNotice)
		}
	}

	/**
	 * Shared read-only preview: probe, discovery, parse, diff — no writes.
	 * The returned commit runs the mutating tail over the same manager.
	 * Cancellation propagates as ScanCancelledError for the caller to report.
	 */
	async previewScan(file?: ScanTarget, control: ScanControl = {}): Promise<ScanPreview> {
		if ((await this.checkConnection(true)) !== null) {
			return { status: 'aborted' }
		}
		const { manager, totalFiles } = await this.prepareManager(file)
		const progress = this.startProgress(control)
		try {
			await manager.initialiseFiles(progress.control)
		} finally {
			progress.close()
		}
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
	async runPreviewSync(file?: ScanTarget, control: ScanControl = {}): Promise<void> {
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

	/**
	 * Check card syntax for the vault, one file, or text that is not saved yet.
	 * Reads only, so it does not take the scan guard. Anki is optional.
	 */
	async validate(target?: { file?: TFile; inline?: { path: string; text: string } }): Promise<ValidationReport> {
		const { manager } = await this.prepareManager(target?.file)
		const inputs = target?.inline
			? [
					{
						...target.inline,
						data: {
							...createFileData(manager.data, manager.data.template.deckName, []),
							mediaExists: manager.mediaExistsFrom(target.inline.path)
						}
					}
				]
			: await manager.validationInputs()
		return validateFiles(inputs, {
			beginNote: this.env.loadState().settings.Syntax['Begin Note'],
			existingIds: await this.readExistingIds(manager)
		})
	}

	/** Anki's note IDs, or undefined when it cannot answer right now. */
	private async readExistingIds(manager: FileManager): Promise<ReadonlySet<number> | undefined> {
		const load = manager.data.loadExistingIds
		if (!load || (await this.env.probeAnki()).status !== 'ready') {
			return undefined
		}
		try {
			return new Set(await load())
		} catch (error) {
			console.warn('[Obsidian_to_Anki] validate could not read note IDs:', error)
			return undefined
		}
	}

	/** Caller-supplied control wins; otherwise the env's progress UI (if any). */
	private startProgress(control: ScanControl): ScanProgressHandle {
		if (control.onProgress || control.isCancelled || !this.env.createProgress) {
			return { control, close: () => undefined }
		}
		return this.env.createProgress()
	}

	/** Probe + file discovery shared by the sync and preview paths. */
	/** null when Anki is ready (scan may proceed); otherwise why it may not. */
	private async checkConnection(dryRun: boolean): Promise<string | null> {
		const { notices } = this.env
		console.info('Checking connection to Anki...')
		const probe = await this.env.probeAnki()
		console.info(`[Obsidian_to_Anki] anki status: ${probe.status}`)
		if (probe.status === 'ready') {
			notices.notify(`Scanning vault (${dryRun ? 'dry-run' : 'sync'})...`)
			return null
		}
		if (probe.status === 'closed' && this.env.isAutoLaunchEnabled()) {
			const outcome = await this.env.launchAnki(true)
			if (outcome === 'launched-and-ready') {
				notices.notify('Anki is now running. Continuing the scan...')
				return null
			}
			const starting = 'Anki is starting in the background. Run the scan again in a few seconds.'
			notices.notify(starting)
			return starting
		}
		notices.notify(probe.message)
		return probe.message
	}

	private async prepareManager(file?: ScanTarget): Promise<{ manager: FileManager; totalFiles: number }> {
		const { notices } = this.env
		const state = this.env.loadState()
		const data: ParsedSettings = await this.env.toData(this.env.app, state.settings, state.fieldsDict)
		const scanDirs = state.settings.Defaults['Scan Directories']
		let manager: FileManager
		if (Array.isArray(file)) {
			manager = this.env.createManager(this.env.app, data, file, state.fileHashes, state.addedMedia)
		} else if (file !== undefined && file !== null) {
			manager = this.env.createManager(this.env.app, data, [file], state.fileHashes, state.addedMedia)
		} else if (scanDirs && scanDirs.length > 0) {
			const markdownFiles: TFile[] = []
			for (const dirPath of scanDirs) {
				const scanDir = this.env.app.vault.getAbstractFileByPath(dirPath)
				if (scanDir instanceof TFolder) {
					console.info('Using custom scan directory: ' + scanDir.path)
					markdownFiles.push(...markdownFilesIn(scanDir))
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
		manager.mediaRecords = { ...state.mediaRecords }
		return { manager, totalFiles: manager.files.length }
	}

	/** Mutating tail shared by direct sync and modal confirm. */
	private async commitManagerResults(manager: FileManager, totalFiles: number): Promise<ScanReport> {
		await manager.requests_1()
		// Structured one-liner for CLI agents and log scraping:
		// [Obsidian_to_Anki] scan complete: files_changed=2/120 added=5 updated=1 deleted=0
		// NOTE: totalFiles is captured before initialiseFiles narrows
		// manager.files down to the changed files — do not recompute it here.
		const issues = manager.scanIssues
		// What really happened: planned adds and deletes minus the rejected ones,
		// and only the notes whose content actually differed from Anki.
		const failedAdds = issues.filter((i) => i.kind === 'add-note').length
		const added = manager.ownFiles.reduce((n, f) => n + f.all_notes_to_add.length, 0) - failedAdds
		const updated = manager.updatedNoteCount()
		// Explicit DELETE lines plus notes whose block vanished from Markdown.
		const deleted =
			manager.ownFiles.reduce((n, f) => n + f.notes_to_delete.length, 0) +
			manager.orphanNoteIds.length -
			manager.failedDeleteCount
		console.info(
			`[Obsidian_to_Anki] scan complete: files_changed=${manager.ownFiles.length}/${totalFiles} added=${added} updated=${updated} deleted=${deleted}${issues.length > 0 ? ` failed=${issues.length}` : ''}`
		)
		this.env.notices.notify(formatScanNotice(manager.ownFiles.length, totalFiles, added, updated, deleted))
		this.notifyMediaResults(manager.resentMedia, issues)
		this.env.commitScanResults(Array.from(manager.added_media_set), manager.getHashes(), manager.mediaRecords)
		return {
			...emptyReport('completed', false),
			filesChanged: manager.ownFiles.length,
			filesTotal: totalFiles,
			added,
			updated,
			deleted,
			converted: manager.convertedCount,
			resentMedia: [...manager.resentMedia],
			issues: [...issues]
		}
	}

	/**
	 * Read-only preview path: same file discovery and parsing as a real scan,
	 * but collects the diff via collectDryRunState instead of dispatching the
	 * mutating batch. Never writes files, hashes or media state.
	 */
	async reportDryRun(
		manager: FileManager,
		totalFiles: number,
		everyFile = false,
		media: MediaPlan = NO_MEDIA_PLAN,
		includeDiff = false
	): Promise<ScanReport> {
		const summary = await collectDryRunState(manager.ownFiles, {
			hasNoteTypeChanges: manager.data.allow_note_type_changes,
			orphanNoteIds: manager.orphanNoteIds,
			orphanFileById: manager.orphanFileById(),
			includeDiff
		})
		summary.filesTotal = totalFiles
		// The full comparison covers what the plan reports, and names the note files.
		const mediaIssues = everyFile ? await manager.findMediaDifferences(media.paths) : media.issues
		this.emitDryRunPreview(summary)
		return {
			...emptyReport('completed', true),
			filesChanged: summary.filesChanged,
			filesTotal: summary.filesTotal,
			added: summary.wouldAdd,
			updated: summary.wouldUpdate,
			deleted: summary.wouldDelete,
			converted: summary.wouldConvert,
			resentMedia: media.resent,
			issues: [...manager.ownFiles.flatMap((file) => file.parseIssues), ...summary.issues, ...mediaIssues],
			details: { decks: summary.decks, changes: summary.changes }
		}
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
