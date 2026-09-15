/*Performing plugin operations on markdown file contents*/

import { FROZEN_FIELDS_DICT } from './interfaces/field-interface'
import { AnkiConnectNote, AnkiConnectNoteAndID } from './interfaces/note-interface'
import { FileData } from './interfaces/settings-interface'
import {
	Note,
	InlineNote,
	RegexNote,
	AbstractNote,
	CLOZE_ERROR,
	NOTE_TYPE_ERROR,
	TAG_SEP,
	ID_REGEXP_STR,
	TAG_REGEXP_STR
} from './note'
import { Md5 } from 'ts-md5'
import * as AnkiConnect from './anki'
import * as c from './constants'
import { FormatConverter } from './format'
import { CachedMetadata, HeadingCache } from 'obsidian'

const double_regexp: RegExp = /(?:\r\n|\r|\n)((?:\r\n|\r|\n)(?:<!--)?ID: \d+)/g

function id_to_str(identifier: number, inline: boolean = false, comment: boolean = false): string {
	let result = 'ID: ' + identifier.toString()
	if (comment) {
		result = '<!--' + result + '-->'
	}
	if (inline) {
		result += ' '
	} else {
		result += '\n'
	}
	return result
}

export function string_insert(text: string, position_inserts: Array<[number, string]>): string {
	/*Insert strings in position_inserts into text, at indices.

    position_inserts will look like:
    [(0, "hi"), (3, "hello"), (5, "beep")]
	Positions refer to coordinates in the ORIGINAL string, so a single
	left-to-right pass (O(L)) replaces the old per-insert realloc (O(N*L)).
	Unlike the previous version, the input array is not sorted in place.*/
	const parts: string[] = []
	let cursor = 0
	const sorted_inserts: Array<[number, string]> = [...position_inserts].sort((a, b): number => a[0] - b[0])
	for (const insertion of sorted_inserts) {
		const position = insertion[0]
		const insert_str = insertion[1]
		parts.push(text.slice(cursor, position))
		parts.push(insert_str)
		cursor = position
	}
	parts.push(text.slice(cursor))
	return parts.join('')
}

function spans(pattern: RegExp, text: string): Array<[number, number]> {
	/*Return a list of span-tuples for matches of pattern in text.*/
	const output: Array<[number, number]> = []
	const matches = text.matchAll(pattern)
	for (const match of matches) {
		output.push([match.index, match.index + match[0].length])
	}
	return output
}

function contained_in(span: [number, number], spans: Array<[number, number]>): boolean {
	/*Return whether span is contained in spans (+- 1 leeway)*/
	return spans.some((element) => span[0] >= element[0] - 1 && span[1] <= element[1] + 1)
}

function* findignore(
	pattern: RegExp,
	text: string,
	ignore_spans: Array<[number, number]>
): IterableIterator<RegExpMatchArray> {
	const matches = text.matchAll(pattern)
	for (const match of matches) {
		if (!contained_in([match.index, match.index + match[0].length], ignore_spans)) {
			yield match
		}
	}
}

abstract class AbstractFile {
	file: string
	path: string
	url: string
	original_file: string
	data: FileData
	file_cache: CachedMetadata

	frozen_fields_dict: FROZEN_FIELDS_DICT = {}
	target_deck = ''
	global_tags = ''
	deckMap: Array<{ position: number; deck: string }> = []
	note_edit_deck_map: Array<{ card_ids: number[]; deck: string }> = []
	frontmatter_has_deck = false

	notes_to_add: AnkiConnectNote[] = []
	id_indexes: number[] = []
	notes_to_edit: AnkiConnectNoteAndID[] = []
	notes_to_delete: number[] = []
	all_notes_to_add: AnkiConnectNote[] = []

	note_ids: Array<number | null> = []
	card_ids: number[] = []
	tags: string[] = []

	formatter: FormatConverter

	constructor(file_contents: string, path: string, url: string, data: FileData, file_cache: CachedMetadata) {
		this.data = data
		this.file = file_contents
		this.path = path
		this.url = url
		this.original_file = this.file
		this.file_cache = file_cache
		this.formatter = new FormatConverter(file_cache, this.data.vault_name)
	}

	setup_frozen_fields_dict() {
		const frozen_fields_dict: FROZEN_FIELDS_DICT = {}
		for (const note_type in this.data.fields_dict) {
			const fields: string[] = this.data.fields_dict[note_type]
			const temp_dict: Record<string, string> = {}
			for (const field of fields) {
				temp_dict[field] = ''
			}
			frozen_fields_dict[note_type] = temp_dict
		}
		for (const match of this.file.matchAll(this.data.FROZEN_REGEXP)) {
			const [note_type, fields]: [string, string] = [match[1], match[2]]
			const virtual_note = note_type + '\n' + fields
			const parsed_fields: Record<string, string> = new Note(
				virtual_note,
				this.data.fields_dict,
				this.data.curly_cloze,
				this.data.highlights_to_cloze,
				this.formatter
			).getFields()
			frozen_fields_dict[note_type] = parsed_fields
		}
		this.frozen_fields_dict = frozen_fields_dict
	}

	setup_target_deck() {
		// Check if a TARGET DECK line exists in YAML frontmatter (between first --- and second ---).
		// If so, lock the entire file to that deck and ignore any body TARGET DECK lines.
		// Otherwise, build a position→deck map from all body TARGET DECK lines.
		this.deckMap = []
		this.frontmatter_has_deck = false

		const firstMatch = this.file.match(this.data.DECK_REGEXP)
		if (!firstMatch) {
			this.target_deck = this.data.template['deckName']
			return
		}

		// Detect frontmatter: must start at position 0 with ---
		const firstSep = this.file.indexOf('---')
		const secondSep = firstSep === 0 ? this.file.indexOf('---', 3) : -1
		const deckPos: number = firstMatch.index ?? 0
		const firstMatchInFrontmatter = firstSep === 0 && secondSep !== -1 && deckPos > firstSep && deckPos < secondSep

		if (firstMatchInFrontmatter) {
			// Frontmatter lock: all cards go to the frontmatter deck, body lines ignored
			this.frontmatter_has_deck = true
			this.target_deck = firstMatch[1]
			this.deckMap = [{ position: 0, deck: firstMatch[1] }]
			return
		}

		// No frontmatter lock: build position→deck map from all body TARGET DECK lines
		this.target_deck = firstMatch[1]
		const deckRegexGlobal = new RegExp(this.data.DECK_REGEXP.source, 'gm')
		for (const match of this.file.matchAll(deckRegexGlobal)) {
			this.deckMap.push({ position: match.index, deck: match[1] })
		}
	}

	getDeckForPosition(position: number): string {
		if (this.frontmatter_has_deck) {
			return this.target_deck
		}
		let result = this.target_deck
		for (const entry of this.deckMap) {
			if (entry.position < position) {
				result = entry.deck
			} else {
				break
			}
		}
		return result
	}

	setup_global_tags() {
		const result = this.file.match(this.data.TAG_REGEXP)
		this.global_tags = result ? result[1] : ''
	}

	getHash(): string {
		return Md5.hashStr(this.file) as string
	}

	/**
	 * Note IDs present in the file text, used for orphan tracking.
	 * IDs consumed by an explicit DELETE line are excluded: those notes are
	 * being removed on purpose, so they must not count as "still present".
	 * IDs inside fenced code blocks are excluded too: a doc example such as
	 * ```<!--ID: 999-->``` must not shield a phantom note from deletion.
	 * (Parser shielding itself is a deliberate NO-GO — see AGENTS.md.)
	 */
	getNoteIdsInFile(): number[] {
		const deleteSpans = spans(this.data.EMPTY_REGEXP, this.file)
		const fenceSpans = spans(c.OBS_DISPLAY_CODE_REGEXP, this.file)
		const ignore = deleteSpans.concat(fenceSpans)
		const ids: number[] = []
		for (const match of this.file.matchAll(/(?:<!--)?ID: (\d+)/g)) {
			const position = match.index ?? 0
			if (ignore.some(([start, end]) => position >= start && position < end)) {
				continue
			}
			ids.push(parseInt(match[1], 10))
		}
		return ids
	}

	abstract scanFile(): void

	scanDeletions() {
		for (const match of this.file.matchAll(this.data.EMPTY_REGEXP)) {
			this.notes_to_delete.push(parseInt(match[1]))
		}
	}

	getContextAtIndex(position: number): string {
		const result: string = this.path
		let currentContext: HeadingCache[] = []
		const headings = this.file_cache.headings
		if (!headings || headings.length === 0) {
			return result
		}
		for (const currentHeading of headings) {
			if (position < currentHeading.position.start.offset) {
				//We've gone past position now with headings, so let's return!
				break
			}
			let insert_index: number = 0
			for (const contextHeading of currentContext) {
				if (currentHeading.level > contextHeading.level) {
					insert_index += 1
					continue
				}
				break
			}
			currentContext = currentContext.slice(0, insert_index)
			currentContext.push(currentHeading)
		}
		const heading_strs: string[] = []
		for (const contextHeading of currentContext) {
			heading_strs.push(contextHeading.heading)
		}
		const result_arr: string[] = [result]
		result_arr.push(...heading_strs)
		return result_arr.join(' > ')
	}

	abstract writeIDs(): void

	removeEmpties() {
		this.file = this.file.replace(this.data.EMPTY_REGEXP, '')
	}

	getCreateDecks(): AnkiConnect.AnkiConnectRequest {
		const actions: AnkiConnect.AnkiConnectRequest[] = []
		for (const note of this.all_notes_to_add) {
			actions.push(AnkiConnect.createDeck(note.deckName))
		}
		return AnkiConnect.multi(actions)
	}

	getAddNotes(): AnkiConnect.AnkiConnectRequest {
		const actions: AnkiConnect.AnkiConnectRequest[] = []
		for (const note of this.all_notes_to_add) {
			actions.push(AnkiConnect.addNote(note))
		}
		return AnkiConnect.multi(actions)
	}

	getDeleteNotes(): AnkiConnect.AnkiConnectRequest {
		return AnkiConnect.deleteNotes(this.notes_to_delete)
	}

	/**
	 * Build the update batch for existing notes. `useUpdateNote` consolidates
	 * fields and tags into one action per note (AnkiConnect >= updateNote);
	 * false keeps the legacy updateNoteFields-only batch.
	 */
	getNoteUpdates(useUpdateNote: boolean): AnkiConnect.AnkiConnectRequest {
		const actions: AnkiConnect.AnkiConnectRequest[] = []
		for (const parsed of this.notes_to_edit) {
			if (parsed.identifier == null) {
				continue
			}
			if (useUpdateNote) {
				actions.push(AnkiConnect.updateNote(parsed.identifier, parsed.note.fields, this.noteTagsFor(parsed)))
			} else {
				actions.push(AnkiConnect.updateNoteFields(parsed.identifier, parsed.note.fields))
			}
		}
		return AnkiConnect.multi(actions)
	}

	/** Tags an existing note should carry in Anki: note tags plus file-level tags. */
	noteTagsFor(parsed: AnkiConnectNoteAndID): string[] {
		return (parsed.note.tags.join(' ') + ' ' + this.global_tags).split(' ').filter((tag) => tag.length > 0)
	}

	getNoteInfo(): AnkiConnect.AnkiConnectRequest {
		const IDs: number[] = []
		for (const parsed of this.notes_to_edit) {
			if (parsed.identifier == null) {
				continue
			}
			IDs.push(parsed.identifier)
		}
		return AnkiConnect.notesInfo(IDs)
	}

	getChangeDecks(): AnkiConnect.AnkiConnectRequest {
		const actions: AnkiConnect.AnkiConnectRequest[] = []
		for (const [deck, cardIds] of this.getTargetDeckByCardGrouped()) {
			if (cardIds.length > 0) {
				actions.push(AnkiConnect.changeDeck(cardIds, deck))
			}
		}
		if (actions.length === 1) {
			return actions[0]
		}
		return AnkiConnect.multi(actions)
	}

	/**
	 * Where the real scan would move each card: card ID → target deck.
	 * Shared by the real scan (requests_2) and the dry-run diff so both agree
	 * on what "the deck should be" means. Must be called after parse.
	 */
	getTargetDeckByCard(): Map<number, string> {
		const byCard = new Map<number, string>()
		for (const [deck, cardIds] of this.getTargetDeckByCardGrouped()) {
			for (const cardId of cardIds) {
				byCard.set(cardId, deck)
			}
		}
		return byCard
	}

	private getTargetDeckByCardGrouped(): Map<string, number[]> {
		if (this.frontmatter_has_deck || this.note_edit_deck_map.length <= 1) {
			return new Map([[this.target_deck, [...this.card_ids]]])
		}
		const byDeck = new Map<string, number[]>()
		for (const group of this.note_edit_deck_map) {
			if (group.card_ids.length > 0) {
				byDeck.set(group.deck, [...(byDeck.get(group.deck) ?? []), ...group.card_ids])
			}
		}
		return byDeck
	}

	getUpdateTags(): AnkiConnect.AnkiConnectRequest {
		const actions: AnkiConnect.AnkiConnectRequest[] = []
		for (const parsed of this.notes_to_edit) {
			if (parsed.identifier == null) {
				continue
			}
			const tags = parsed.note.tags.join(' ') + ' ' + this.global_tags
			actions.push(AnkiConnect.updateNoteTags(parsed.identifier, tags.split(' ')))
		}
		return AnkiConnect.multi(actions)
	}
}

export class AllFile extends AbstractFile {
	ignore_spans: [number, number][] = []
	custom_regexps: Record<string, string>
	inline_notes_to_add: AnkiConnectNote[] = []
	inline_id_indexes: number[] = []
	regex_notes_to_add: AnkiConnectNote[] = []
	regex_id_indexes: number[] = []

	constructor(file_contents: string, path: string, url: string, data: FileData, file_cache: CachedMetadata) {
		super(file_contents, path, url, data, file_cache)
		this.custom_regexps = data.custom_regexps
	}

	add_spans_to_ignore() {
		this.ignore_spans = []
		const hasCustomRegexps = Object.values(this.custom_regexps).some((r) => Boolean(r && r.trim()))
		if (!hasCustomRegexps) {
			return
		}
		this.ignore_spans.push(...spans(this.data.FROZEN_REGEXP, this.file))
		const deckRegexGlobal = new RegExp(this.data.DECK_REGEXP.source, 'gm')
		for (const match of this.file.matchAll(deckRegexGlobal)) {
			this.ignore_spans.push([match.index, match.index + match[0].length])
		}
		const tag_result = this.file.match(this.data.TAG_REGEXP)
		if (tag_result) {
			const tagPos: number = tag_result.index ?? 0
			this.ignore_spans.push([tagPos, tagPos + tag_result[0].length])
		}
		this.ignore_spans.push(...spans(this.data.NOTE_REGEXP, this.file))
		this.ignore_spans.push(...spans(this.data.INLINE_REGEXP, this.file))
		this.ignore_spans.push(...spans(c.OBS_INLINE_MATH_REGEXP, this.file))
		this.ignore_spans.push(...spans(c.OBS_DISPLAY_MATH_REGEXP, this.file))
		this.ignore_spans.push(...spans(c.OBS_CODE_REGEXP, this.file))
		this.ignore_spans.push(...spans(c.OBS_DISPLAY_CODE_REGEXP, this.file))
	}

	setupScan() {
		this.setup_frozen_fields_dict()
		this.setup_target_deck()
		this.setup_global_tags()
		this.add_spans_to_ignore()
		this.notes_to_add = []
		this.inline_notes_to_add = []
		this.regex_notes_to_add = []
		this.id_indexes = []
		this.inline_id_indexes = []
		this.regex_id_indexes = []
		this.notes_to_edit = []
		this.notes_to_delete = []
		this.note_edit_deck_map = []
	}

	scanPattern(
		pattern: RegExp,
		createNote: (text: string) => AbstractNote,
		notesToAdd: AnkiConnectNote[],
		idIndexes: number[]
	) {
		for (const note_match of this.file.matchAll(pattern)) {
			const [note, position]: [string, number] = [
				note_match[1],
				note_match.index + note_match[0].indexOf(note_match[1]) + note_match[1].length
			]
			const parsed = createNote(note).parse(
				this.getDeckForPosition(note_match.index),
				this.url,
				this.frozen_fields_dict,
				this.data,
				this.data.add_context ? this.getContextAtIndex(note_match.index) : ''
			)
			if (parsed.identifier == null) {
				parsed.note.tags.push(...this.global_tags.split(TAG_SEP))
				notesToAdd.push(parsed.note)
				idIndexes.push(position)
			} else if (!this.data.EXISTING_IDS.has(parsed.identifier)) {
				if (parsed.identifier == CLOZE_ERROR) {
					continue
				} else if (parsed.identifier == NOTE_TYPE_ERROR) {
					console.warn('Did not recognise note type ', parsed.note.modelName, ' in file ', this.path)
				} else {
					console.warn('Note with id', parsed.identifier, ' in file ', this.path, ' does not exist in Anki!')
				}
			} else {
				this.notes_to_edit.push(parsed)
			}
		}
	}

	scanNotes() {
		this.scanPattern(
			this.data.NOTE_REGEXP,
			(note) =>
				new Note(
					note,
					this.data.fields_dict,
					this.data.curly_cloze,
					this.data.highlights_to_cloze,
					this.formatter
				),
			this.notes_to_add,
			this.id_indexes
		)
	}

	scanInlineNotes() {
		this.scanPattern(
			this.data.INLINE_REGEXP,
			(note) =>
				new InlineNote(
					note,
					this.data.fields_dict,
					this.data.curly_cloze,
					this.data.highlights_to_cloze,
					this.formatter
				),
			this.inline_notes_to_add,
			this.inline_id_indexes
		)
	}

	search(note_type: string, regexp_str: string) {
		//Search the file for regex matches
		//ignoring matches inside ignore_spans,
		//and adding any matches to ignore_spans.
		for (const search_id of [true, false]) {
			for (const search_tags of [true, false]) {
				const id_str = search_id ? ID_REGEXP_STR : ''
				const tag_str = search_tags ? TAG_REGEXP_STR : ''
				const regexp: RegExp = new RegExp(regexp_str + tag_str + id_str, 'gm')
				for (const match of findignore(regexp, this.file, this.ignore_spans)) {
					const matchPos: number = match.index ?? 0
					this.ignore_spans.push([matchPos, matchPos + match[0].length])
					const parsed: AnkiConnectNoteAndID = new RegexNote(
						match,
						note_type,
						this.data.fields_dict,
						search_tags,
						search_id,
						this.data.curly_cloze,
						this.data.highlights_to_cloze,
						this.formatter
					).parse(
						this.getDeckForPosition(matchPos),
						this.url,
						this.frozen_fields_dict,
						this.data,
						this.data.add_context ? this.getContextAtIndex(matchPos) : ''
					)
					if (search_id) {
						if (parsed.identifier == null || !this.data.EXISTING_IDS.has(parsed.identifier)) {
							if (parsed.identifier == CLOZE_ERROR) {
								// This means it wasn't actually a note! So we should remove it from ignore_spans
								this.ignore_spans.pop()
								continue
							}
							console.warn(
								'Note with id',
								parsed.identifier,
								' in file ',
								this.path,
								' does not exist in Anki!'
							)
						} else {
							this.notes_to_edit.push(parsed)
						}
					} else {
						if (parsed.identifier == CLOZE_ERROR) {
							// This means it wasn't actually a note! So we should remove it from ignore_spans
							this.ignore_spans.pop()
							continue
						}
						parsed.note.tags.push(...this.global_tags.split(TAG_SEP))
						this.regex_notes_to_add.push(parsed.note)
						this.regex_id_indexes.push(matchPos + match[0].length)
					}
				}
			}
		}
	}

	scanFile() {
		this.setupScan()
		this.scanNotes()
		this.scanInlineNotes()
		for (const note_type in this.custom_regexps) {
			const regexp_str: string = this.custom_regexps[note_type]
			if (regexp_str) {
				this.search(note_type, regexp_str)
			}
		}
		this.all_notes_to_add = this.notes_to_add.concat(this.inline_notes_to_add).concat(this.regex_notes_to_add)
		this.scanDeletions()
	}

	fix_newline_ids() {
		this.file = this.file.replace(double_regexp, '$1')
	}

	writeIDs() {
		const normal_inserts: [number, string][] = []
		this.id_indexes.forEach((id_position: number, index: number) => {
			const identifier: number | null = this.note_ids[index]
			if (identifier) {
				normal_inserts.push([id_position, id_to_str(identifier, false, this.data.comment)])
			}
		})
		const inline_inserts: [number, string][] = []
		this.inline_id_indexes.forEach((id_position: number, index: number) => {
			const identifier: number | null = this.note_ids[index + this.notes_to_add.length] //Since regular then inline
			if (identifier) {
				inline_inserts.push([id_position, id_to_str(identifier, true, this.data.comment)])
			}
		})
		const regex_inserts: [number, string][] = []
		this.regex_id_indexes.forEach((id_position: number, index: number) => {
			const identifier: number | null =
				this.note_ids[index + this.notes_to_add.length + this.inline_notes_to_add.length] // Since regular then inline then regex
			if (identifier) {
				regex_inserts.push([id_position, '\n' + id_to_str(identifier, false, this.data.comment)])
			}
		})
		this.file = string_insert(this.file, normal_inserts.concat(inline_inserts).concat(regex_inserts))
		this.fix_newline_ids()
	}
}
