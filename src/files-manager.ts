/*Class for managing a list of files, and their Anki requests.*/
import { ParsedSettings, FileData } from './interfaces/settings-interface'
import { App, TFile, TFolder, TAbstractFile, CachedMetadata, FileSystemAdapter, Notice } from 'obsidian'
import { AllFile } from './file'
import * as AnkiConnect from './anki'
import { basename } from 'path'
import multimatch from 'multimatch'
import {
	createFileData,
	isFileUnchanged,
	isStatUnchanged,
	mapConcurrent,
	FileHashes,
	VAULT_SCAN_YIELD_INTERVAL,
	yieldToEventLoop
} from './scan-optimizations'
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

function difference<T>(setA: Set<T>, setB: Set<T>): Set<T> {
	const _difference = new Set(setA)
	for (const elem of setB) {
		_difference.delete(elem)
	}
	return _difference
}

export class FileManager {
	app: App
	data: ParsedSettings
	files: TFile[]
	ownFiles: Array<AllFile>
	file_hashes: FileHashes
	requests_1_result: unknown[] | null = null
	added_media_set: Set<string>
	private useUpdateNote = false

	constructor(app: App, data: ParsedSettings, files: TFile[], file_hashes: FileHashes, added_media: string[]) {
		this.app = app
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
		let ignoredFiles = []
		ignoredFiles = multimatch(
			files.map((file) => file.path),
			data.ignored_file_globs
		)

		const notIgnoredFiles = files.filter((file) => !ignoredFiles.contains(file.path))
		return notIgnoredFiles
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

	async initialiseFiles() {
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

		// Pass 2: Read candidate files with bounded concurrency (8 workers)
		const readResults = await mapConcurrent(candidateFiles, 8, async (obFile) => {
			const content = await this.app.vault.read(obFile)
			return { obFile, content }
		})

		// Pass 3: Verify content hash and scan changed/new files
		for (let index = 0; index < readResults.length; index++) {
			const { obFile, content } = readResults[index]

			if (!isFileUnchanged(obFile.path, content, this.file_hashes)) {
				const cache: CachedMetadata = this.app.metadataCache.getCache(obFile.path) ?? {}
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

			if ((index + 1) % VAULT_SCAN_YIELD_INTERVAL === 0) {
				await yieldToEventLoop()
			}
		}

		this.ownFiles = files_changed
		this.files = obfiles_changed
	}

	async requests_1() {
		const requests: AnkiConnect.AnkiConnectRequest[] = []
		// One reflection call per scan decides which late actions this daemon
		// supports. Failures degrade to the legacy paths (see detectSupportedActions).
		const supported = await AnkiConnect.detectSupportedActions(['updateNote'])
		this.useUpdateNote = supported.has('updateNote')
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
		requests.push(AnkiConnect.multi(temp))
		temp = []
		console.info('Requesting addition of media...')
		for (const file of this.ownFiles) {
			const mediaLinks = difference(file.formatter.detectedMedia, this.added_media_set)
			for (const mediaLink of mediaLinks) {
				console.log('Adding media file: ', mediaLink)
				const dataFile = this.app.metadataCache.getFirstLinkpathDest(mediaLink, file.path)
				if (!dataFile) {
					console.warn("Couldn't locate media file ", mediaLink)
				} else {
					// Located successfully, so treat as if we've added the media
					this.added_media_set.add(mediaLink)
					const realPath = (this.app.vault.adapter as FileSystemAdapter).getFullPath(dataFile.path)
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
		if (response[5].result.length >= 1 && response[5].result[0].error != null) {
			new Notice('Please update AnkiConnect! The way the script has added media files has changed.')
			console.warn('Please update AnkiConnect! The way the script has added media files has changed.')
		}
		let note_ids_array_by_file: Requests1Result[0]['result']
		try {
			note_ids_array_by_file = AnkiConnect.parse(response[0])
		} catch (error) {
			console.error('Error: ', error)
			note_ids_array_by_file = response[0].result
		}
		const note_info_array_by_file = AnkiConnect.parse(response[1])
		const tag_list: string[] = AnkiConnect.parse(response[2])
		for (let i = 0; i < note_ids_array_by_file.length; i++) {
			const file = this.ownFiles[i]
			let file_response: addNoteResponse[]
			try {
				file_response = AnkiConnect.parse(note_ids_array_by_file[i])
			} catch (error) {
				console.error('Error: ', error)
				file_response = note_ids_array_by_file[i].result
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
				}
			}
		}
		for (let i = 0; i < note_info_array_by_file.length; i++) {
			const file = this.ownFiles[i]
			const file_response = AnkiConnect.parse(note_info_array_by_file[i])
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
				await this.app.vault.modify(obFile, ownFile.file)
			}
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
				size: obFile?.stat?.size ?? 0
			}
		}
		return result
	}

	async requests_2(): Promise<void> {
		const requests: AnkiConnect.AnkiConnectRequest[] = []
		let temp: AnkiConnect.AnkiConnectRequest[] = []
		console.info('Requesting cards to be moved to target deck...')
		for (const file of this.ownFiles) {
			const deck = file.getChangeDecks()
			const cards = deck.params['cards']
			if (Array.isArray(cards) && cards.length > 0) {
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
		await AnkiConnect.invoke('multi', { actions: requests })
		if (this.data.sync_to_ankiweb) {
			console.info('Triggering AnkiWeb sync...')
			try {
				await AnkiConnect.invoke('sync')
			} catch (e) {
				// A local scan succeeded; a failed cloud sync must not fail it.
				console.warn('AnkiWeb sync failed:', e)
				new Notice('Sync to Anki completed, but AnkiWeb sync failed. Check console for details.')
			}
		}
		console.info('All done!')
	}
}
