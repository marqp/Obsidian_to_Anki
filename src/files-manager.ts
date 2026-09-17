/*Class for managing a list of files, and their Anki requests.*/
import { ParsedSettings, FileData } from './interfaces/settings-interface'
import { AnkiConnectNoteAndID } from './interfaces/note-interface'
import { App, TFile, TFolder, TAbstractFile, CachedMetadata, FileSystemAdapter } from 'obsidian'
import { obsidianNoticePort, type NoticePort } from './notices'
import { AllFile } from './file'
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
 * stays the documented trust boundary); entries 3/4 (updates, deletes) are
 * fire-and-forget and intentionally unread.
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
	kind: 'add-notes' | 'note-info' | 'add-note' | 'notes-info' | 'note-info-file' | 'tag-list'
	/** The AnkiConnect error message (never the full payload). */
	error: string
}

/**
 * Everything the scan needs from the Obsidian side, behind one interface so
 * the pipeline can run against fakes in unit tests (no App/Electron). The
 * production adapter wraps App; see vaultPortFromApp.
 */
export interface VaultPort {
	read(file: TFile): Promise<string>
	modify(file: TFile, data: string): Promise<void>
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
		modify: (file, data) => app.vault.modify(file, data),
		getCache: (path) => app.metadataCache.getCache(path) ?? {},
		getFirstLinkpathDest: (linkpath, sourcePath) => app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath),
		getFullPath: (path) => (app.vault.adapter as FileSystemAdapter).getFullPath(path)
	}
}

function difference<T>(setA: Set<T>, setB: Set<T>): Set<T> {
	const _difference = new Set(setA)
	for (const elem of setB) {
		_difference.delete(elem)
	}
	return _difference
}

/** Message text for a ScanIssue (mirrors the transport's error rendering). */
function issueMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
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
	/** Failures collected by the last parse_requests_1 run (reset per scan). */
	scanIssues: ScanIssue[] = []
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
		return createFileData(
			this.data,
			this.getDefaultDeck(file, folder_path_list),
			this.getDefaultTags(file, folder_path_list)
		)
	}

	async initialiseFiles(control: ScanControl = {}) {
		const files_changed: Array<AllFile> = []
		const obfiles_changed: TFile[] = []

		// Pass 1: Fast-path negative filter using in-memory stat (mtime + size).
		// Files whose mtime and size match cache cannot have changed — skip reading them from disk!
		const candidateFiles: TFile[] = []
		for (const obFile of this.files) {
			const cached = this.file_hashes[obFile.path]
			if (obFile.stat && isStatUnchanged(obFile.stat, cached)) {
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

			if (!isFileUnchanged(obFile.path, content, this.file_hashes)) {
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
		this.orphanNoteIds = this.computeOrphanNoteIds(files_changed)
		if (this.orphanNoteIds.length > 0) {
			console.info(`Notes removed from Markdown will be deleted from Anki: ${this.orphanNoteIds.join(', ')}`)
		}
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
	 * tracked file are kept, and only IDs Anki still reports are returned.
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

	async requests_1() {
		const requests: AnkiConnect.AnkiConnectRequest[] = []
		this.scanIssues = []
		// One reflection call per scan decides which late actions this daemon
		// supports. Failures degrade to the legacy paths (see detectSupportedActions).
		const supported = await AnkiConnect.detectSupportedActions(['updateNote', 'updateNoteModel'])
		this.useUpdateNote = supported.has('updateNote')
		this.useUpdateNoteModel = supported.has('updateNoteModel')
		if (this.useUpdateNote) {
			console.info('AnkiConnect supports updateNote: field and tag updates will be consolidated.')
		}
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
		for (const file of this.ownFiles) {
			const mediaLinks = difference(file.formatter.detectedMedia, this.added_media_set)
			for (const mediaLink of mediaLinks) {
				console.log('Adding media file: ', mediaLink)
				const dataFile = this.vault.getFirstLinkpathDest(mediaLink, file.path)
				if (!dataFile) {
					console.warn("Couldn't locate media file ", mediaLink)
				} else {
					// Located successfully, so treat as if we've added the media
					this.added_media_set.add(mediaLink)
					const realPath = this.vault.getFullPath(dataFile.path)
					temp.push(AnkiConnect.storeMediaFileByPath(basename(mediaLink), realPath))
				}
			}
		}
		requests.push(AnkiConnect.multi(temp))
		temp = []
		this.requests_1_result = await AnkiConnect.invoke<unknown[]>('multi', { actions: requests })
		await this.parse_requests_1()
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
				this.scanIssues.push({ file: file.path, kind: 'note-info', error: issueMessage(error) })
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
				this.detectModelChange(file, noteToEdit, note_response.modelName)
			}
			file.card_ids = temp
		}
		for (let i = 0; i < this.ownFiles.length; i++) {
			const ownFile = this.ownFiles[i]
			const obFile = this.files[i]
			ownFile.tags = tag_list
			ownFile.writeIDs()
			ownFile.removeEmpties()
			if (ownFile.file !== ownFile.original_file) {
				await this.vault.modify(obFile, ownFile.file)
			}
		}
		if (this.scanIssues.length > 0) {
			// Separate line from the machine-readable `scan complete:` summary
			// (owned by main.ts) so agent scraping never breaks.
			console.info('[Obsidian_to_Anki] scan issues: ' + JSON.stringify(this.scanIssues))
		}
		await this.requests_2()
	}

	getHashes(): FileHashes {
		const result: FileHashes = {}
		for (let i = 0; i < this.ownFiles.length; i++) {
			const file = this.ownFiles[i]
			const obFile = this.files[i]
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
			return
		}
		if (!this.useUpdateNoteModel) {
			console.warn(`AnkiConnect does not support updateNoteModel; cannot convert note ${parsed.identifier}.`)
			return
		}
		this.modelChangeActions.push(
			AnkiConnect.updateNoteModel(parsed.identifier, localModelName, parsed.note.fields, file.noteTagsFor(parsed))
		)
		console.info(`Queued note type change for ${parsed.identifier}: ${ankiModelName} -> ${localModelName}`)
	}

	async requests_2(): Promise<void> {
		const requests: AnkiConnect.AnkiConnectRequest[] = []
		let temp: AnkiConnect.AnkiConnectRequest[] = []
		console.info('Requesting cards to be moved to target deck...')
		for (const file of this.ownFiles) {
			const deck = file.getChangeDecks()
			if (deckHasCards(deck)) {
				temp.push(deck)
			}
		}
		requests.push(AnkiConnect.multi(temp))
		temp = []
		if (!this.useUpdateNote) {
			console.info('Requesting tags to be replaced...')
			for (const file of this.ownFiles) {
				const update = file.getUpdateTags()
				const actions = update.params['actions']
				if (Array.isArray(actions) && actions.length > 0) {
					temp.push(update)
				}
			}
			requests.push(AnkiConnect.multi(temp))
			temp = []
		} else {
			console.info('Skipping tag replacement: tags were consolidated into updateNote.')
		}
		if (this.modelChangeActions.length > 0) {
			console.info('Requesting note type changes...')
			requests.push(AnkiConnect.multi(this.modelChangeActions))
			this.modelChangeActions = []
		}
		await AnkiConnect.invoke('multi', { actions: requests })
		if (this.data.sync_to_ankiweb) {
			console.info('Triggering AnkiWeb sync...')
			try {
				await AnkiConnect.invoke('sync')
			} catch (e) {
				// A local scan succeeded; a failed cloud sync must not fail it.
				console.warn('AnkiWeb sync failed:', e)
				this.notifier.notify('Sync to Anki completed, but AnkiWeb sync failed. Check console for details.')
			}
		}
		console.info('All done!')
	}
}
