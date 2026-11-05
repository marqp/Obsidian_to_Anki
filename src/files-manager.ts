/*Class for managing a list of files, and their Anki requests.*/
import { ParsedSettings, FileData } from './interfaces/settings-interface'
import { AnkiConnectNoteAndID } from './interfaces/note-interface'
import { App, TFile, TFolder, TAbstractFile, CachedMetadata, FileSystemAdapter } from 'obsidian'
import { obsidianNoticePort, type NoticePort } from './notices'
import { AllFile } from './file'
import { clozeCardsEmptied, isContentMismatch, noteTypeMismatch, occlusionMasksReplaced } from './dry-run'
import { ANKI_STATUS_TAGS } from './requests'
import type { ValidationInput } from './validate'
import * as AnkiConnect from './anki'
import { basename } from 'path'
import multimatch from 'multimatch'
import {
	createFileData,
	findOrphanedNoteIds,
	isFileUnchanged,
	isStatUnchanged,
	mapConcurrent,
	FileHashes,
	VAULT_SCAN_YIELD_INTERVAL,
	yieldToEventLoop
} from './scan-optimizations'

/** Re-exported from src/notices.ts for existing importers. */
export type { NoticePort } from './notices'

interface addNoteResponse {
	result: number
	error: string | null
}

interface notesInfoResponse {
	result: Array<{
		noteId: number
		modelName: string
		tags: string[]
		fields: Record<
			string,
			{
				order: number
				value: string
			}
		>
		cards: number[]
	}>
	error: string | null
}

interface Requests1Result {
	0: {
		error: string | null
		result: Array<{
			result: addNoteResponse[]
			error: string | null
		}>
	}
	1: {
		error: string | null
		result: notesInfoResponse[]
	}
	2: {
		error: string | null
		result: string[]
	}
	3: unknown
	4: unknown
	5: {
		error: string | null
		result: Array<{
			error: string | null
		}>
	}
}

/**
 * The requests_1 batch with names instead of positional indexes, so
 * reordering the batch in requests_1() can no longer silently desync
 * parse_requests_1(). Built once from the raw wire shape (the single cast
 * stays the documented trust boundary). Entries 3/4 (updates, deletes) stay
 * `unknown` and are read defensively by actionErrors().
 */
interface Requests1Batch {
	addedIds: Requests1Result[0]
	notesInfo: Requests1Result[1]
	tagList: Requests1Result[2]
	updates: Requests1Result[3]
	deletes: Requests1Result[4]
	media: Requests1Result[5]
}

/** A single note/batch failure collected during parse_requests_1. */
export interface ScanIssue {
	/** File whose note failed ('' for batch-level failures). */
	file: string
	/** Machine-stable category; the console summary groups by it. */
	kind:
		| 'add-notes'
		| 'add-notes-file'
		| 'add-note'
		| 'notes-info'
		| 'note-info-file'
		| 'tag-list'
		| 'media'
		| 'media-missing'
		| 'media-differs'
		| 'file-changed'
		| 'update-note'
		| 'delete-note'
		| 'change-deck'
		| 'update-tags'
		| 'convert-note'
		| 'note-type-mismatch'
		| 'cloze-card-emptied'
		| 'occlusion-masks-replaced'
		| 'ankiweb-sync'
		| 'cloze-without-deletions'
		| 'occlusion-image-missing'
		| 'unknown-note-type'
		| 'stale-note-id'
		| 'duplicate-note-id'
	/** The AnkiConnect error message (never the full payload). */
	error: string
	/** 1-based line of the note, when the problem belongs to one block. */
	line?: number
	/** Start of the note's text, to identify it without opening the file. */
	snippet?: string
	/** The Anki note involved, when it has one. */
	noteId?: number
}

/**
 * Everything the scan needs from the Obsidian side, behind one interface so
 * the pipeline can run against fakes in unit tests (no App/Electron). The
 * production adapter wraps App; see vaultPortFromApp.
 */
export interface VaultPort {
	read(file: TFile): Promise<string>
	readBinary(file: TFile): Promise<ArrayBuffer>
	/** Every Markdown file in the vault, including those outside the scan. */
	markdownFiles(): TFile[]
	/** Atomic read-modify-write; `fn` receives the file's current content. */
	process(file: TFile, fn: (data: string) => string): Promise<string>
	getCache(path: string): CachedMetadata
	getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null
	/** Absolute filesystem path for a vault file (desktop adapter only). */
	getFullPath(path: string): string
}

/** Notice surface used by the scan; injectable so tests never touch the UI. */
// (Moved to src/notices.ts; re-exported above for existing importers.)

function vaultPortFromApp(app: App): VaultPort {
	return {
		read: (file) => app.vault.read(file),
		readBinary: (file) => app.vault.readBinary(file),
		markdownFiles: () => app.vault.getMarkdownFiles(),
		process: (file, fn) => app.vault.process(file, fn),
		getCache: (path) => app.metadataCache.getCache(path) ?? {},
		getFirstLinkpathDest: (linkpath, sourcePath) => app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath),
		getFullPath: (path) => (app.vault.adapter as FileSystemAdapter).getFullPath(path)
	}
}

/** Anki and the disk can each change a name's case and Unicode form. */
function mediaKey(link: string): string {
	return basename(link).normalize('NFC').toLowerCase()
}

/** Message text for a ScanIssue (mirrors the transport's error rendering). */
function issueMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/**
 * Failures a later scan can repair by trying again, so the file must stay
 * "changed". The rest (a note Anki can never accept as written, a missing
 * media file, a failed cloud sync) would only repeat until the user acts.
 */
const RETRYABLE_ISSUES: ReadonlySet<ScanIssue['kind']> = new Set<ScanIssue['kind']>([
	'add-notes',
	'add-notes-file',
	'add-note',
	'notes-info',
	'note-info-file',
	'media',
	'update-note',
	'delete-note',
	'change-deck',
	'update-tags',
	'convert-note',
	// The fix is outside the file: adding the image changes nothing a hash would see.
	'occlusion-image-missing'
])

/** Every error inside one `multi` result, however deeply its batches nest. */
function actionErrors(entry: unknown): string[] {
	if (typeof entry !== 'object' || entry === null) {
		return []
	}
	const { error, result } = entry as { error?: unknown; result?: unknown }
	const errors = error == null ? [] : [issueMessage(error)]
	if (Array.isArray(result)) {
		errors.push(...result.flatMap(actionErrors))
	}
	return errors
}

/** The per-action results of a `multi` result ([] when it failed as a whole). */
function actionResults(entry: unknown): unknown[] {
	const result = typeof entry === 'object' && entry !== null ? (entry as { result?: unknown }).result : undefined
	return Array.isArray(result) ? result : []
}

/** Who a follow-up action in requests_2 was for. */
interface ActionTarget {
	file: string
	noteId?: number
}

/** True when a changeDeck payload (or a multi wrapping them) actually moves cards. */
function deckHasCards(deck: AnkiConnect.AnkiConnectRequest): boolean {
	const cards = deck.params['cards']
	if (Array.isArray(cards)) {
		return cards.length > 0
	}
	const actions = deck.params['actions']
	return (
		Array.isArray(actions) &&
		actions.some((action) => {
			const nested = (action as AnkiConnect.AnkiConnectRequest).params?.['cards']
			return Array.isArray(nested) && nested.length > 0
		})
	)
}

export interface ScanProgress {
	/** Files fully processed (read + hash-verified + scanned). */
	done: number
	/** Total candidate files (after stat fast-path; 0 when unknown). */
	total: number
	/** Current phase: discovery (stat filter/reads) or scan (parse). */
	phase: 'discover' | 'scan'
}

export interface ScanControl {
	/** Called after each yield point; cooperative only, never blocks. */
	onProgress?: (progress: ScanProgress) => void
	/** Polled at each yield point; when true the scan stops at the next boundary. */
	isCancelled?: () => boolean
	/**
	 * Reads every file, even those the stored hashes call unchanged. For a dry-run
	 * that compares the whole vault with Anki: a real scan must not use it, since it
	 * would rewrite and resend files that did not change.
	 */
	everyFile?: boolean
}

/** Thrown at yield boundaries when ScanControl.isCancelled() returns true. */
export class ScanCancelledError extends Error {
	constructor() {
		super('Scan cancelled by user.')
		this.name = 'ScanCancelledError'
	}
}

export class FileManager {
	app: App
	data: ParsedSettings
	files: TFile[]
	ownFiles: Array<AllFile>
	file_hashes: FileHashes
	requests_1_result: unknown[] | null = null
	added_media_set: Set<string>
	orphanNoteIds: number[] = []
	private useUpdateNote = false
	private useUpdateNoteModel = false
	private modelChangeActions: AnkiConnect.AnkiConnectRequest[] = []
	private modelChangeTargets: ActionTarget[] = []
	/** Notes that differed from Anki when this scan read them. */
	private changedNoteIds = new Set<number>()
	private failedUpdateIds = new Set<number>()
	/** Notes this scan meant to delete but Anki refused. */
	failedDeleteCount = 0
	/** Notes whose type this scan really converted. */
	convertedCount = 0
	/** Failures collected by the last parse_requests_1 run (reset per scan). */
	scanIssues: ScanIssue[] = []
	/**
	 * (file, link) pairs in upload order, aligned positionally with the
	 * media sub-batch results so per-item failures attribute correctly.
	 */
	private mediaUploads: Array<{ file: string; link: string }> = []
	private readonly vault: VaultPort
	private readonly notifier: NoticePort

	constructor(
		app: App,
		data: ParsedSettings,
		files: TFile[],
		file_hashes: FileHashes,
		added_media: string[],
		ports: { vault?: VaultPort; notices?: NoticePort } = {}
	) {
		this.app = app
		this.vault = ports.vault ?? vaultPortFromApp(app)
		this.notifier = ports.notices ?? obsidianNoticePort
		this.data = data

		this.files = this.findFilesThatAreNotIgnored(files, data)

		this.ownFiles = []
		this.file_hashes = file_hashes
		this.added_media_set = new Set(added_media)
	}
	getUrl(file: TFile): string {
		return (
			'obsidian://open?vault=' +
			encodeURIComponent(this.data.vault_name) +
			String.raw`&file=` +
			encodeURIComponent(file.path)
		)
	}

	/** Every file a scan would look at, whether or not it changed. */
	async validationInputs(): Promise<ValidationInput[]> {
		const inputs: ValidationInput[] = []
		for (const file of this.findFilesThatAreNotIgnored(this.files, this.data)) {
			inputs.push({ path: file.path, text: await this.vault.read(file), data: this.dataToFileData(file) })
			if (inputs.length % VAULT_SCAN_YIELD_INTERVAL === 0) {
				await yieldToEventLoop()
			}
		}
		return inputs
	}

	findFilesThatAreNotIgnored(files: TFile[], data: ParsedSettings): TFile[] {
		if (data.ignored_file_globs.length === 0) {
			return files
		}
		const ignoredPaths = new Set<string>(
			multimatch(
				files.map((file) => file.path),
				data.ignored_file_globs
			)
		)

		return files.filter((file) => !ignoredPaths.has(file.path))
	}

	getFolderPathList(file: TFile): TFolder[] {
		const result: TFolder[] = []
		let abstractFile: TAbstractFile | null = file
		while (abstractFile && abstractFile.parent) {
			result.push(abstractFile.parent)
			abstractFile = abstractFile.parent
		}
		result.pop() // Removes top-level vault
		return result
	}

	getDefaultDeck(file: TFile, folder_path_list: TFolder[]): string {
		const folder_decks = this.data.folder_decks
		for (const folder of folder_path_list) {
			// Loops over them from innermost folder
			if (folder_decks[folder.path]) {
				return folder_decks[folder.path]
			}
		}
		// If no decks specified
		return this.data.template.deckName
	}

	getDefaultTags(file: TFile, folder_path_list: TFolder[]): string[] {
		const folder_tags = this.data.folder_tags
		const tags_list: string[] = []
		for (const folder of folder_path_list) {
			// Loops over them from innermost folder
			if (folder_tags[folder.path]) {
				tags_list.push(...folder_tags[folder.path].split(' '))
			}
		}
		tags_list.push(...this.data.template.tags)
		return tags_list
	}

	dataToFileData(file: TFile): FileData {
		const folder_path_list: TFolder[] = this.getFolderPathList(file)
		return {
			...createFileData(
				this.data,
				this.getDefaultDeck(file, folder_path_list),
				this.getDefaultTags(file, folder_path_list)
			),
			mediaExists: this.mediaExistsFrom(file.path)
		}
	}

	/** Resolves links as the media step of a scan does, from this file's location. */
	mediaExistsFrom(path: string): (link: string) => boolean {
		return (link) => this.vault.getFirstLinkpathDest(link, path) !== null
	}

	async initialiseFiles(control: ScanControl = {}) {
		const files_changed: Array<AllFile> = []
		const obfiles_changed: TFile[] = []

		// Pass 1: Fast-path negative filter using in-memory stat (mtime + size).
		// Files whose mtime and size match cache cannot have changed — skip reading them from disk!
		const candidateFiles: TFile[] = []
		for (const obFile of this.files) {
			const cached = this.file_hashes[obFile.path]
			if (!control.everyFile && obFile.stat && isStatUnchanged(obFile.stat, cached)) {
				continue
			}
			candidateFiles.push(obFile)
		}
		control.onProgress?.({ done: 0, total: candidateFiles.length, phase: 'discover' })

		// Pass 2: Read candidate files with bounded concurrency (8 workers)
		const readResults = await mapConcurrent(candidateFiles, 8, async (obFile) => {
			const content = await this.vault.read(obFile)
			return { obFile, content }
		})
		this.throwIfCancelled(control)

		// Pass 3: Verify content hash and scan changed/new files
		for (let index = 0; index < readResults.length; index++) {
			const { obFile, content } = readResults[index]

			if (control.everyFile || !isFileUnchanged(obFile.path, content, this.file_hashes)) {
				await this.ensureExistingIds()
				const cache: CachedMetadata = this.vault.getCache(obFile.path)
				const file = new AllFile(
					content,
					obFile.path,
					this.data.add_file_link ? this.getUrl(obFile) : '',
					this.dataToFileData(obFile),
					cache
				)

				console.info('Scanning ', file.path, "as it's changed or new.")
				file.scanFile()
				files_changed.push(file)
				obfiles_changed.push(obFile)
			}

			if ((index + 1) % VAULT_SCAN_YIELD_INTERVAL === 0 || index + 1 === readResults.length) {
				control.onProgress?.({ done: index + 1, total: readResults.length, phase: 'scan' })
				await yieldToEventLoop()
				this.throwIfCancelled(control)
			}
		}

		this.ownFiles = files_changed
		this.files = obfiles_changed
		this.orphanNoteIds = await this.withoutIdsElsewhere(this.computeOrphanNoteIds(files_changed), files_changed)
		this.throwIfCancelled(control)
		if (this.orphanNoteIds.length > 0) {
			console.info(`Notes removed from Markdown will be deleted from Anki: ${this.orphanNoteIds.join(', ')}`)
		}
	}

	/**
	 * A block cut from a scanned file and pasted into one this scan did not read
	 * is not an orphan, yet the stored records cannot show it: they learn the new
	 * place only when that file is scanned. Deleting would lose the card's review
	 * history, so anything about to be deleted is first looked for in the rest of
	 * the vault. Scans that delete nothing read no extra file.
	 */
	private async withoutIdsElsewhere(orphanIds: number[], scanned: AllFile[]): Promise<number[]> {
		if (orphanIds.length === 0) {
			return orphanIds
		}
		const scannedPaths = new Set(scanned.map((file) => file.path))
		const others = this.vault.markdownFiles().filter((file) => !scannedPaths.has(file.path))
		const found = new Set<number>()
		await mapConcurrent(others, 8, async (obFile) => {
			const content = await this.vault.read(obFile)
			const file = new AllFile(
				content,
				obFile.path,
				'',
				createFileData(this.data, '', []),
				this.vault.getCache(obFile.path)
			)
			for (const id of file.getNoteIdsInFile()) {
				found.add(id)
			}
		})
		return orphanIds.filter((id) => !found.has(id))
	}

	/** Load the Anki note-ID set once, the first time a changed file needs it. */
	private async ensureExistingIds(): Promise<void> {
		const load = this.data.loadExistingIds
		if (!load) {
			return
		}
		const ids = await load()
		this.data = { ...this.data, EXISTING_IDS: new Set(ids), loadExistingIds: undefined }
	}

	private throwIfCancelled(control: ScanControl): void {
		if (control.isCancelled?.()) {
			throw new ScanCancelledError()
		}
	}

	/**
	 * File that last carried each orphan ID, from the stored hash records.
	 * Lets read-only previews (dry-run) group deletes per file; the mutating
	 * path keeps using the bare orphanNoteIds list.
	 */
	orphanFileById(): Map<number, string> {
		const fileById = new Map<number, string>()
		for (const [path, entry] of Object.entries(this.file_hashes)) {
			if (typeof entry === 'string' || !Array.isArray(entry.noteIds)) {
				continue
			}
			for (const id of entry.noteIds) {
				if (this.orphanNoteIds.includes(id) && !fileById.has(id)) {
					fileById.set(id, path)
				}
			}
		}
		return fileById
	}

	/**
	 * Note IDs whose blocks disappeared from the scanned files since the last
	 * scan. Safe by construction: files with no stored record (first scan,
	 * rename, new file) never produce orphans, IDs still referenced by another
	 * tracked file are kept, and only IDs Anki still reports are returned. The
	 * caller then checks the files this scan did not read.
	 */
	computeOrphanNoteIds(currentFiles: AllFile[]): number[] {
		if (!this.data.delete_removed_notes) {
			return []
		}
		const storedIdsByPath: Record<string, number[]> = {}
		for (const [path, entry] of Object.entries(this.file_hashes)) {
			if (typeof entry !== 'string' && Array.isArray(entry.noteIds)) {
				storedIdsByPath[path] = entry.noteIds
			}
		}
		const currentIdsByPath: Record<string, number[]> = {}
		const explicitDeletes = new Set<number>()
		for (const file of currentFiles) {
			currentIdsByPath[file.path] = file.getNoteIdsInFile()
			for (const id of file.notes_to_delete) {
				explicitDeletes.add(id)
			}
		}
		return findOrphanedNoteIds(storedIdsByPath, currentIdsByPath, this.data.EXISTING_IDS).filter(
			(id) => !explicitDeletes.has(id)
		)
	}

	/**
	 * Updates replace a note's whole tag list, so tags Anki set during study must
	 * be read first. The notesInfo of the main batch runs too late: those updates
	 * are already built by then.
	 */
	private async keepAnkiStatusTags(): Promise<void> {
		const edits = this.ownFiles.flatMap((file) => file.notes_to_edit)
		if (edits.length === 0) {
			return
		}
		for (const tag of ANKI_STATUS_TAGS) {
			const tagged = new Set(await AnkiConnect.invoke<number[]>('findNotes', { query: `tag:${tag}` }))
			for (const parsed of edits) {
				if (parsed.identifier != null && tagged.has(parsed.identifier) && !parsed.note.tags.includes(tag)) {
					parsed.note.tags = [...parsed.note.tags, tag]
				}
			}
		}
	}

	async requests_1() {
		const requests: AnkiConnect.AnkiConnectRequest[] = []
		this.scanIssues = this.ownFiles.flatMap((file) => file.parseIssues)
		this.mediaUploads = []
		this.changedNoteIds = new Set()
		this.failedUpdateIds = new Set()
		this.failedDeleteCount = 0
		this.convertedCount = 0
		// One reflection call per scan decides which late actions this daemon
		// supports. Failures degrade to the legacy paths (see detectSupportedActions).
		const supported = await AnkiConnect.detectSupportedActions(['updateNote', 'updateNoteModel'])
		this.useUpdateNote = supported.has('updateNote')
		this.useUpdateNoteModel = supported.has('updateNoteModel')
		if (this.useUpdateNote) {
			console.info('AnkiConnect supports updateNote: field and tag updates will be consolidated.')
		}
		await this.keepAnkiStatusTags()
		console.info('Requesting addition of new deck into Anki...')
		const uniqueDecks = new Set<string>()
		for (const file of this.ownFiles) {
			for (const note of file.all_notes_to_add) {
				if (note.deckName) {
					uniqueDecks.add(note.deckName)
				}
			}
		}
		let temp: AnkiConnect.AnkiConnectRequest[] = []
		for (const deck of uniqueDecks) {
			temp.push(AnkiConnect.createDeck(deck))
		}
		requests.push(AnkiConnect.multi(temp))
		temp = []
		console.info('Requesting addition of notes into Anki...')
		for (const file of this.ownFiles) {
			temp.push(file.getAddNotes())
		}
		requests.push(AnkiConnect.multi(temp))
		temp = []
		console.info('Requesting card IDs of notes to be edited...')
		for (const file of this.ownFiles) {
			temp.push(file.getNoteInfo())
		}
		requests.push(AnkiConnect.multi(temp))
		temp = []
		console.info('Requesting tag list...')
		requests.push(AnkiConnect.getTags())
		console.info('Requesting update of fields of existing notes')
		for (const file of this.ownFiles) {
			temp.push(file.getNoteUpdates(this.useUpdateNote))
		}
		requests.push(AnkiConnect.multi(temp))
		temp = []
		console.info('Requesting deletion of notes..')
		for (const file of this.ownFiles) {
			temp.push(file.getDeleteNotes())
		}
		if (this.orphanNoteIds.length > 0) {
			temp.push(AnkiConnect.deleteNotes(this.orphanNoteIds))
		}
		requests.push(AnkiConnect.multi(temp))
		temp = []
		console.info('Requesting addition of media...')
		const inAnki = await this.mediaInAnki()
		for (const file of this.ownFiles) {
			for (const mediaLink of file.formatter.detectedMedia) {
				if (this.added_media_set.has(mediaLink) && (inAnki === null || inAnki.has(mediaKey(mediaLink)))) {
					continue
				}
				console.log('Adding media file: ', mediaLink)
				const dataFile = this.vault.getFirstLinkpathDest(mediaLink, file.path)
				if (!dataFile) {
					console.warn("Couldn't locate media file ", mediaLink)
					this.scanIssues.push({
						file: file.path,
						kind: 'media-missing',
						error: `Couldn't locate media file ${mediaLink}`
					})
				} else {
					// Located successfully, so treat as if we've added the media
					this.added_media_set.add(mediaLink)
					inAnki?.add(mediaKey(mediaLink))
					const realPath = this.vault.getFullPath(dataFile.path)
					this.mediaUploads.push({ file: file.path, link: mediaLink })
					temp.push(AnkiConnect.storeMediaFileByPath(basename(mediaLink), realPath))
				}
			}
		}
		requests.push(AnkiConnect.multi(temp))
		temp = []
		this.requests_1_result = await AnkiConnect.invoke<unknown[]>('multi', { actions: requests })
		await this.parse_requests_1()
	}

	/**
	 * The media Anki holds now. `Added Media` only says a file was sent once, and
	 * Anki can drop it later, as Check Media does with files no card uses. Null
	 * when nothing needs checking or Anki can't say: then that cache decides.
	 */
	private async mediaInAnki(): Promise<Set<string> | null> {
		const needsCheck = this.ownFiles.some((file) =>
			[...file.formatter.detectedMedia].some((link) => this.added_media_set.has(link))
		)
		if (!needsCheck) {
			return null
		}
		try {
			const names = await AnkiConnect.invoke<string[]>('getMediaFilesNames', { pattern: '*' })
			return new Set(names.map(mediaKey))
		} catch (error) {
			console.warn('Could not list the media in Anki: ', error)
			return null
		}
	}

	/**
	 * Compares the files the scanned notes cite with Anki's copies, writing nothing.
	 * `Added Media` keeps only names, so a changed file or a reused name never reaches
	 * Anki. Sending it here could overwrite the only good copy, so this only reports.
	 * It costs one request per file, which is why only an everyFile dry-run calls it.
	 */
	async findMediaDifferences(): Promise<ScanIssue[]> {
		const issues: ScanIssue[] = []
		const compared = new Set<string>()
		for (const file of this.ownFiles) {
			for (const link of file.formatter.detectedMedia) {
				const dataFile = this.vault.getFirstLinkpathDest(link, file.path)
				if (!dataFile) {
					issues.push({ file: file.path, kind: 'media-missing', error: `Couldn't locate media file ${link}` })
				} else if (!compared.has(dataFile.path)) {
					compared.add(dataFile.path)
					const issue = await this.compareMedia(file.path, link, dataFile)
					if (issue) {
						issues.push(issue)
					}
				}
			}
		}
		return issues
	}

	private async compareMedia(path: string, link: string, dataFile: TFile): Promise<ScanIssue | null> {
		try {
			const name = basename(link)
			const encoded = await AnkiConnect.invoke<string | false>('retrieveMediaFile', { filename: name })
			if (encoded === false) {
				return {
					file: path,
					kind: 'media-differs',
					error: `${name} is in the vault but not in Anki's media folder.`
				}
			}
			const inVault = Buffer.from(await this.vault.readBinary(dataFile))
			if (Buffer.from(encoded, 'base64').equals(inVault)) {
				return null
			}
			return {
				file: path,
				kind: 'media-differs',
				error: `${name} in the vault differs from the file of that name in Anki, and notes in Anki show Anki's file.`
			}
		} catch (error) {
			return { file: path, kind: 'media', error: `Could not compare ${link}: ${issueMessage(error)}` }
		}
	}

	async parse_requests_1() {
		if (!this.requests_1_result) {
			throw new AnkiConnect.AnkiConnectError('multi', 'missing batch response')
		}
		// Trust boundary: the wire payload is cast once to the batch shape,
		// dropping the createDeck entry (index 0), which needs no processing.
		const response = this.requests_1_result.slice(1) as unknown as Requests1Result
		const batch: Requests1Batch = {
			addedIds: response[0],
			notesInfo: response[1],
			tagList: response[2],
			updates: response[3],
			deletes: response[4],
			media: response[5]
		}
		if (batch.media.result.length >= 1 && batch.media.result[0].error != null) {
			this.notifier.notify('Please update AnkiConnect! The way the script has added media files has changed.')
			console.warn('Please update AnkiConnect! The way the script has added media files has changed.')
		}
		// Per-item upload failures were previously silent (only the legacy
		// result[0] check above existed). Attribute each failed upload to its
		// file; the scan otherwise completes normally.
		for (let i = 0; i < batch.media.result.length; i++) {
			const item = batch.media.result[i]
			if (item && item.error != null) {
				const upload = this.mediaUploads[i]
				// Marked as added when queued; a failed upload must be queued again.
				if (upload) {
					this.added_media_set.delete(upload.link)
				}
				this.scanIssues.push({
					file: upload?.file ?? '',
					kind: 'media',
					error: issueMessage(item.error)
				})
			}
		}
		this.readUpdateResults(batch.updates)
		const undeletedFiles = this.readDeleteResults(batch.deletes)
		let note_ids_array_by_file: Requests1Result[0]['result']
		try {
			note_ids_array_by_file = AnkiConnect.parse(batch.addedIds)
		} catch (error) {
			console.error('Error: ', error)
			note_ids_array_by_file = batch.addedIds.result
			this.scanIssues.push({ file: '', kind: 'add-notes', error: issueMessage(error) })
		}
		// Per-file fault isolation: one file's malformed notesInfo must not
		// abort the remaining files (or the tag list, ID stamping, and
		// requests_2 below). Failures become ScanIssues; the file keeps its
		// empty deck-map defaults and the scan continues.
		let note_info_array_by_file: Requests1Result[1]['result']
		try {
			note_info_array_by_file = AnkiConnect.parse(batch.notesInfo)
		} catch (error) {
			console.error('Error: ', error)
			note_info_array_by_file = []
			this.scanIssues.push({ file: '', kind: 'notes-info', error: issueMessage(error) })
			this.assumeNotesChanged(this.ownFiles)
		}
		let tag_list: string[]
		try {
			tag_list = AnkiConnect.parse(batch.tagList)
		} catch (error) {
			console.error('Error: ', error)
			tag_list = []
			this.scanIssues.push({ file: '', kind: 'tag-list', error: issueMessage(error) })
		}
		for (let i = 0; i < note_ids_array_by_file.length; i++) {
			const file = this.ownFiles[i]
			let file_response: addNoteResponse[]
			try {
				file_response = AnkiConnect.parse(note_ids_array_by_file[i])
			} catch (error) {
				console.error('Error: ', error)
				file_response = note_ids_array_by_file[i].result
				this.scanIssues.push({ file: file.path, kind: 'add-notes-file', error: issueMessage(error) })
			}
			file.note_ids = []
			for (let j = 0; j < file_response.length; j++) {
				const response = file_response[j]
				try {
					file.note_ids.push(AnkiConnect.parse(response))
				} catch (error) {
					console.warn(
						'Failed to add note ',
						file.all_notes_to_add[j],
						' in file',
						file.path,
						' due to error ',
						error
					)
					file.note_ids.push(response.result)
					this.scanIssues.push({ file: file.path, kind: 'add-note', error: issueMessage(error) })
				}
			}
		}
		for (let i = 0; i < note_info_array_by_file.length; i++) {
			const file = this.ownFiles[i]
			let file_response: Requests1Result[1]['result'][number]['result']
			try {
				file_response = AnkiConnect.parse(note_info_array_by_file[i])
			} catch (error) {
				console.error('Error: ', error)
				this.scanIssues.push({ file: file.path, kind: 'note-info-file', error: issueMessage(error) })
				this.assumeNotesChanged([file])
				continue
			}
			const temp: number[] = []
			file.note_edit_deck_map = []
			for (let j = 0; j < file_response.length; j++) {
				const note_response = file_response[j]
				const noteToEdit = file.notes_to_edit[j]
				if (!note_response || !noteToEdit) {
					continue
				}
				temp.push(...note_response.cards)
				file.note_edit_deck_map.push({
					card_ids: note_response.cards,
					deck: noteToEdit.note.deckName
				})
				// The batch runs in order, so this read shows the note before its
				// update: it tells which notes the scan really changed.
				if (
					noteToEdit.identifier != null &&
					noteToEdit.note.modelName === note_response.modelName &&
					isContentMismatch(noteToEdit.note, file.noteTagsFor(noteToEdit), note_response)
				) {
					this.changedNoteIds.add(noteToEdit.identifier)
				}
				const emptied = clozeCardsEmptied(file, noteToEdit, note_response)
				if (emptied) {
					this.scanIssues.push(emptied)
				}
				const replaced = occlusionMasksReplaced(file, noteToEdit, note_response)
				if (replaced) {
					this.scanIssues.push(replaced)
				}
				this.detectModelChange(file, noteToEdit, note_response.modelName)
			}
			file.card_ids = temp
		}
		for (let i = 0; i < this.ownFiles.length; i++) {
			const ownFile = this.ownFiles[i]
			const obFile = this.files[i]
			ownFile.tags = tag_list
			ownFile.writeIDs()
			// A DELETE line stays until the delete worked, so the retry can see it.
			if (!undeletedFiles.has(ownFile.path)) {
				ownFile.removeEmpties()
			}
			if (ownFile.file !== ownFile.original_file) {
				// process() hands us the file's current text. If the user edited it
				// while the sync ran, the id offsets no longer apply: keep their
				// edit and report instead of clobbering it.
				let conflicted = false
				await this.vault.process(obFile, (current) => {
					if (current !== ownFile.original_file) {
						conflicted = true
						return current
					}
					return ownFile.file
				})
				if (conflicted) {
					this.scanIssues.push({
						file: ownFile.path,
						kind: 'file-changed',
						error: 'File was edited during the sync; note IDs were not written. Re-scan may create duplicate cards.'
					})
				}
			}
		}
		await this.requests_2()
		if (this.scanIssues.length > 0) {
			// Separate line from the machine-readable `scan complete:` summary
			// (owned by main.ts) so agent scraping never breaks.
			console.info('[Obsidian_to_Anki] scan issues: ' + JSON.stringify(this.scanIssues))
		}
	}

	/** Attribute failed note updates to their file and note. */
	private readUpdateResults(updates: unknown): void {
		const perFile = actionResults(updates)
		if (perFile.length === 0) {
			for (const error of actionErrors(updates)) {
				this.scanIssues.push({ file: '', kind: 'update-note', error })
			}
			return
		}
		perFile.forEach((fileEntry, fileIndex) => {
			const file = this.ownFiles[fileIndex]
			const edits = file?.notes_to_edit.filter((parsed) => parsed.identifier != null) ?? []
			const results = actionResults(fileEntry)
			if (results.length === 0) {
				for (const error of actionErrors(fileEntry)) {
					this.scanIssues.push({ file: file?.path ?? '', kind: 'update-note', error })
					for (const parsed of edits) {
						this.failedUpdateIds.add(parsed.identifier as number)
					}
				}
				return
			}
			results.forEach((noteEntry, noteIndex) => {
				const noteId = edits[noteIndex]?.identifier ?? undefined
				for (const error of actionErrors(noteEntry)) {
					this.scanIssues.push({ file: file?.path ?? '', kind: 'update-note', error, noteId })
					if (noteId !== undefined) {
						this.failedUpdateIds.add(noteId)
					}
				}
			})
		})
	}

	/**
	 * Attribute failed deletes: one entry per file, then the orphan batch.
	 * Returns the files whose DELETE lines must stay.
	 */
	private readDeleteResults(deletes: unknown): Set<string> {
		const undeleted = new Set<string>()
		const fail = (file: AllFile | undefined, error: string): void => {
			this.scanIssues.push({ file: file?.path ?? '', kind: 'delete-note', error })
			this.failedDeleteCount += file ? file.notes_to_delete.length : this.orphanNoteIds.length
			if (file) {
				undeleted.add(file.path)
			}
		}
		const perBatch = actionResults(deletes)
		if (perBatch.length === 0) {
			for (const error of actionErrors(deletes)) {
				this.ownFiles.forEach((file) => fail(file, error))
				fail(undefined, error)
			}
			return undeleted
		}
		perBatch.forEach((entry, index) => {
			for (const error of actionErrors(entry)) {
				fail(this.ownFiles[index], error)
			}
		})
		return undeleted
	}

	/** Report failures of one requests_2 batch; returns how many targets failed. */
	private readFollowUpResults(batch: unknown, kind: ScanIssue['kind'], targets: ActionTarget[]): number {
		const results = actionResults(batch)
		if (results.length === 0) {
			const errors = actionErrors(batch)
			for (const error of errors) {
				this.scanIssues.push({ file: '', kind, error })
			}
			return errors.length > 0 ? targets.length : 0
		}
		let failed = 0
		results.forEach((entry, index) => {
			const errors = actionErrors(entry)
			if (errors.length > 0) {
				failed += 1
			}
			const target = targets[index]
			for (const error of errors) {
				this.scanIssues.push({
					file: target?.file ?? '',
					kind,
					error,
					...(target?.noteId === undefined ? {} : { noteId: target.noteId })
				})
			}
		})
		return failed
	}

	/** Without the read there is nothing to compare: count what was sent. */
	private assumeNotesChanged(files: AllFile[]): void {
		for (const file of files) {
			for (const parsed of file.notes_to_edit) {
				if (parsed.identifier != null) {
					this.changedNoteIds.add(parsed.identifier)
				}
			}
		}
	}

	/** Notes whose content this scan really changed in Anki. */
	updatedNoteCount(): number {
		let count = 0
		for (const noteId of this.changedNoteIds) {
			if (!this.failedUpdateIds.has(noteId)) {
				count += 1
			}
		}
		return count
	}

	/**
	 * Hash records to commit. A file with a repairable failure gets none: its
	 * previous record stays, so the next scan sees it as changed and tries again.
	 */
	getHashes(): FileHashes {
		const result: FileHashes = {}
		const retry = new Set(this.scanIssues.filter((i) => RETRYABLE_ISSUES.has(i.kind)).map((i) => i.file))
		for (let i = 0; i < this.ownFiles.length; i++) {
			const file = this.ownFiles[i]
			const obFile = this.files[i]
			// '' marks a whole batch that failed, so every file is affected.
			if (retry.has('') || retry.has(file.path)) {
				continue
			}
			result[file.path] = {
				hash: file.getHash(),
				mtime: obFile?.stat?.mtime ?? 0,
				size: obFile?.stat?.size ?? 0,
				noteIds: file.getNoteIdsInFile()
			}
		}
		return result
	}

	/**
	 * Compare the note type in Markdown against the one Anki reports.
	 * Mismatches are surfaced; conversion is queued only when the user opted
	 * into "Allow Note Type Changes" and the daemon supports updateNoteModel.
	 * Anki discards fields absent from the new model, so this is deliberately
	 * opt-in rather than automatic.
	 */
	private detectModelChange(file: AllFile, parsed: AnkiConnectNoteAndID, ankiModelName: string): void {
		const localModelName = parsed.note.modelName
		if (parsed.identifier == null || !localModelName || !ankiModelName || localModelName === ankiModelName) {
			return
		}
		if (!this.data.allow_note_type_changes) {
			console.warn(
				`Note ${parsed.identifier} in file ${file.path} is "${localModelName}" but "${ankiModelName}" in Anki. Enable "Allow Note Type Changes" in the plugin settings to convert it.`
			)
			this.scanIssues.push(noteTypeMismatch(file, parsed.identifier, localModelName, ankiModelName))
			return
		}
		if (!this.useUpdateNoteModel) {
			console.warn(`AnkiConnect does not support updateNoteModel; cannot convert note ${parsed.identifier}.`)
			this.scanIssues.push({
				file: file.path,
				kind: 'note-type-mismatch',
				noteId: parsed.identifier,
				error: `Note is "${localModelName}" in Markdown but "${ankiModelName}" in Anki, and this AnkiConnect cannot convert it.`
			})
			return
		}
		this.modelChangeActions.push(
			AnkiConnect.updateNoteModel(parsed.identifier, localModelName, parsed.note.fields, file.noteTagsFor(parsed))
		)
		this.modelChangeTargets.push({ file: file.path, noteId: parsed.identifier })
		console.info(`Queued note type change for ${parsed.identifier}: ${ankiModelName} -> ${localModelName}`)
	}

	async requests_2(): Promise<void> {
		const requests: AnkiConnect.AnkiConnectRequest[] = []
		let temp: AnkiConnect.AnkiConnectRequest[] = []
		const batches: Array<{ kind: ScanIssue['kind']; targets: ActionTarget[] }> = []
		console.info('Requesting cards to be moved to target deck...')
		let targets: ActionTarget[] = []
		for (const file of this.ownFiles) {
			const deck = file.getChangeDecks()
			if (deckHasCards(deck)) {
				temp.push(deck)
				targets.push({ file: file.path })
			}
		}
		requests.push(AnkiConnect.multi(temp))
		batches.push({ kind: 'change-deck', targets })
		temp = []
		if (!this.useUpdateNote) {
			console.info('Requesting tags to be replaced...')
			targets = []
			for (const file of this.ownFiles) {
				const update = file.getUpdateTags()
				const actions = update.params['actions']
				if (Array.isArray(actions) && actions.length > 0) {
					temp.push(update)
					targets.push({ file: file.path })
				}
			}
			requests.push(AnkiConnect.multi(temp))
			batches.push({ kind: 'update-tags', targets })
			temp = []
		} else {
			console.info('Skipping tag replacement: tags were consolidated into updateNote.')
		}
		const conversionIndex = this.modelChangeActions.length > 0 ? requests.length : -1
		if (this.modelChangeActions.length > 0) {
			console.info('Requesting note type changes...')
			requests.push(AnkiConnect.multi(this.modelChangeActions))
			batches.push({ kind: 'convert-note', targets: this.modelChangeTargets })
			this.modelChangeActions = []
			this.modelChangeTargets = []
		}
		const results = await AnkiConnect.invoke<unknown>('multi', { actions: requests })
		if (Array.isArray(results)) {
			batches.forEach((batch, index) => {
				// A batch nothing was sent for has no result worth reading.
				if (batch.targets.length === 0) {
					return
				}
				const failed = this.readFollowUpResults(results[index], batch.kind, batch.targets)
				if (index === conversionIndex) {
					this.convertedCount = batch.targets.length - failed
				}
			})
		}
		if (this.data.sync_to_ankiweb) {
			console.info('Triggering AnkiWeb sync...')
			try {
				await AnkiConnect.invoke('sync')
			} catch (e) {
				// A local scan succeeded; a failed cloud sync must not fail it.
				console.warn('AnkiWeb sync failed:', e)
				this.notifier.notify('Sync to Anki completed, but AnkiWeb sync failed. Check console for details.')
				this.scanIssues.push({ file: '', kind: 'ankiweb-sync', error: issueMessage(e) })
			}
		}
		console.info('All done!')
	}
}
