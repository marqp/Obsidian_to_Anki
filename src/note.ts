/*Manages parsing notes into a dictionary formatted for AnkiConnect.

Input must be the note text.
Does NOT deal with finding the note in the file.*/

import { FormatConverter } from './format'
import { AnkiConnectNote, AnkiConnectNoteAndID } from './interfaces/note-interface'
import { FIELDS_DICT, FROZEN_FIELDS_DICT } from './interfaces/field-interface'
import { FileData } from './interfaces/settings-interface'

const TAG_PREFIX: string = 'Tags: '
export const TAG_SEP: string = ' '
export const ID_REGEXP_STR: string = String.raw`\n?(?:<!--)?(?:ID: (\d+).*)`
export const TAG_REGEXP_STR: string = String.raw`(Tags: .*)`
const OBS_TAG_REGEXP: RegExp = /(?<=^|[\t ])#([\p{L}\p{N}\p{Emoji}\p{M}_/-]+)/gu

const ANKI_CLOZE_REGEXP: RegExp = /{{c\d+::[\s\S]+?}}/
export const CLOZE_ERROR: number = 42
export const NOTE_TYPE_ERROR: number = 69

function has_clozes(text: string): boolean {
	/*Checks whether text actually has cloze deletions.*/
	return ANKI_CLOZE_REGEXP.test(text)
}

function note_has_clozes(note: AnkiConnectNote): boolean {
	/*Checks whether a note has cloze deletions in any of its fields.*/
	return Object.values(note.fields).some(has_clozes)
}

export function cloneTemplate(template: AnkiConnectNote): AnkiConnectNote {
	return {
		deckName: template.deckName,
		modelName: template.modelName,
		fields: { ...template.fields },
		options: { ...template.options },
		tags: [...template.tags]
	}
}

export function formatNoteFields(
	fields: Record<string, string>,
	modelName: string,
	curlyCloze: boolean,
	highlightsToCloze: boolean,
	formatter: FormatConverter
): Record<string, string> {
	const isCloze = modelName.includes('Cloze') && curlyCloze
	const formatted: Record<string, string> = {}
	for (const [key, value] of Object.entries(fields)) {
		formatted[key] = formatter.format(value.trim(), isCloze, highlightsToCloze).trim()
	}
	return formatted
}

export interface BuildAnkiNoteParams {
	template: AnkiConnectNote
	modelName: string
	fields: Record<string, string>
	tags: string[]
	identifier: number | null
	deck: string
	url?: string
	context?: string
	frozenFieldsDict?: FROZEN_FIELDS_DICT
	data: FileData
	formatter: FormatConverter
	noNoteType?: boolean
}

export function buildAnkiNote(params: BuildAnkiNoteParams): AnkiConnectNoteAndID {
	const {
		template: baseTemplate,
		modelName,
		fields,
		tags,
		deck,
		url,
		context,
		frozenFieldsDict,
		data,
		formatter,
		noNoteType
	} = params

	const template = cloneTemplate(baseTemplate)
	template.modelName = modelName
	if (noNoteType) {
		return { note: template, identifier: NOTE_TYPE_ERROR }
	}

	template.fields = fields
	if (url && data.file_link_fields[modelName]) {
		formatter.format_note_with_url(template, url, data.file_link_fields[modelName])
	}
	if (frozenFieldsDict && Object.keys(frozenFieldsDict).length) {
		formatter.format_note_with_frozen_fields(template, frozenFieldsDict)
	}
	if (context && data.context_fields[modelName]) {
		const contextField = data.context_fields[modelName]
		template.fields[contextField] = (template.fields[contextField] || '') + '<br>' + context
	}

	let identifier = params.identifier
	if (modelName.includes('Cloze') && !note_has_clozes(template)) {
		identifier = CLOZE_ERROR
	}

	const finalTags = [...tags]
	if (data.add_obs_tags) {
		for (const [key, value] of Object.entries(template.fields)) {
			for (const match of value.matchAll(OBS_TAG_REGEXP)) {
				finalTags.push(match[1])
			}
			template.fields[key] = value.replace(OBS_TAG_REGEXP, '')
		}
	}
	template.tags.push(...finalTags)
	template.deckName = deck

	return { note: template, identifier }
}

export abstract class AbstractNote {
	text: string
	split_text: string[]
	current_field_num: number
	delete: boolean
	identifier: number | null
	tags: string[]
	note_type: string
	field_names: string[] = []
	current_field = ''
	ID_REGEXP: RegExp = /(?:<!--)?ID: (\d+)/
	formatter: FormatConverter
	curly_cloze: boolean
	highlights_to_cloze: boolean
	no_note_type: boolean

	constructor(
		note_text: string,
		fields_dict: FIELDS_DICT,
		curly_cloze: boolean,
		highlights_to_cloze: boolean,
		formatter: FormatConverter
	) {
		this.text = note_text.trim()
		this.current_field_num = 0
		this.delete = false
		this.no_note_type = false
		this.split_text = this.getSplitText()
		this.identifier = this.getIdentifier()
		this.tags = this.getTags()
		this.note_type = this.getNoteType()
		this.formatter = formatter
		this.curly_cloze = curly_cloze
		this.highlights_to_cloze = highlights_to_cloze
		if (!fields_dict.hasOwnProperty(this.note_type)) {
			this.no_note_type = true
			return
		}
		this.field_names = fields_dict[this.note_type]
		this.current_field = this.field_names[0]
	}

	abstract getSplitText(): string[]

	abstract getIdentifier(): number | null

	abstract getTags(): string[]

	abstract getNoteType(): string

	abstract getFields(): Record<string, string>

	parse(
		deck: string,
		url: string,
		frozen_fields_dict: FROZEN_FIELDS_DICT,
		data: FileData,
		context: string
	): AnkiConnectNoteAndID {
		return buildAnkiNote({
			template: data.template,
			modelName: this.note_type,
			fields: this.no_note_type ? {} : this.getFields(),
			tags: this.tags,
			identifier: this.identifier,
			deck,
			url,
			context,
			frozenFieldsDict: frozen_fields_dict,
			data,
			formatter: this.formatter,
			noNoteType: this.no_note_type
		})
	}
}

export class Note extends AbstractNote {
	getSplitText(): string[] {
		return this.text.split('\n')
	}

	getIdentifier(): number | null {
		const lastLine = this.split_text[this.split_text.length - 1]
		if (lastLine === undefined) {
			return null
		}
		const idMatch = this.ID_REGEXP.exec(lastLine)
		if (!idMatch) {
			return null
		}
		this.split_text.pop()
		return parseInt(idMatch[1])
	}

	getTags(): string[] {
		const lastLine = this.split_text[this.split_text.length - 1]
		if (lastLine === undefined || !lastLine.startsWith(TAG_PREFIX)) {
			return []
		}
		this.split_text.pop()
		return lastLine.slice(TAG_PREFIX.length).split(TAG_SEP)
	}

	getNoteType(): string {
		return this.split_text[0].trim()
	}

	fieldFromLine(line: string): [string, string] {
		/*From a given line, determine the next field to add text into.

        Then, return the stripped line, and the field.*/
		for (const field of this.field_names) {
			if (line.startsWith(field + ':')) {
				return [line.slice((field + ':').length), field]
			}
		}
		return [line, this.current_field]
	}

	getFields(): Record<string, string> {
		if (!this.field_names) return {}
		const fields: Record<string, string> = {}
		for (const field of this.field_names) {
			fields[field] = ''
		}
		for (let line of this.split_text.slice(1)) {
			;[line, this.current_field] = this.fieldFromLine(line)
			fields[this.current_field] += line + '\n'
		}
		return formatNoteFields(fields, this.note_type, this.curly_cloze, this.highlights_to_cloze, this.formatter)
	}
}

export class InlineNote extends AbstractNote {
	static TAG_REGEXP: RegExp = /Tags: (.*)/
	static ID_REGEXP: RegExp = /(?:<!--)?ID: (\d+)/
	static TYPE_REGEXP: RegExp = /\[(.*?)\]/

	getSplitText(): string[] {
		return this.text.split(' ')
	}

	getIdentifier(): number | null {
		const result = this.text.match(InlineNote.ID_REGEXP)
		if (result) {
			const idPos: number = result.index ?? this.text.length
			this.text = this.text.slice(0, idPos).trim()
			return parseInt(result[1])
		} else {
			return null
		}
	}

	getTags(): string[] {
		const result = this.text.match(InlineNote.TAG_REGEXP)
		if (result) {
			const tagsPos: number = result.index ?? this.text.length
			this.text = this.text.slice(0, tagsPos).trim()
			return result[1].split(TAG_SEP)
		} else {
			return []
		}
	}

	getNoteType(): string {
		const result = this.text.match(InlineNote.TYPE_REGEXP)
		if (!result) {
			return ''
		}
		const typePos: number = result.index ?? 0
		this.text = this.text.slice(typePos + result[0].length)
		return result[1].trim()
	}

	getFields(): Record<string, string> {
		const fields: Record<string, string> = {}
		for (const field of this.field_names) {
			fields[field] = ''
		}
		for (let word of this.text.split(' ')) {
			for (const field of this.field_names) {
				if (word === field + ':') {
					this.current_field = field
					word = ''
				}
			}
			fields[this.current_field] += word + ' '
		}
		return formatNoteFields(fields, this.note_type, this.curly_cloze, this.highlights_to_cloze, this.formatter)
	}
}

export class RegexNote {
	match: RegExpMatchArray
	note_type: string
	identifier: number | null
	tags: string[]
	field_names: string[]
	curly_cloze: boolean
	highlights_to_cloze: boolean
	formatter: FormatConverter

	constructor(
		match: RegExpMatchArray,
		note_type: string,
		fields_dict: FIELDS_DICT,
		tags: boolean,
		id: boolean,
		curly_cloze: boolean,
		highlights_to_cloze: boolean,
		formatter: FormatConverter
	) {
		this.match = match
		this.note_type = note_type
		// `?? ''` keeps the historical parseInt('') -> NaN behavior without
		// asserting on an element the regex contract guarantees.
		this.identifier = id ? parseInt(this.match.pop() ?? '') : null
		this.tags = tags ? (this.match.pop() ?? '').slice(TAG_PREFIX.length).split(TAG_SEP) : []
		this.field_names = fields_dict[note_type]
		this.curly_cloze = curly_cloze
		this.formatter = formatter
		this.highlights_to_cloze = highlights_to_cloze
	}

	getFields(): Record<string, string> {
		const fields: Record<string, string> = {}
		for (const field of this.field_names) {
			fields[field] = ''
		}
		const captures = this.match.slice(1)
		for (let i = 0; i < captures.length; i++) {
			fields[this.field_names[i]] = captures[i] ? captures[i] : ''
		}
		return formatNoteFields(fields, this.note_type, this.curly_cloze, this.highlights_to_cloze, this.formatter)
	}

	parse(
		deck: string,
		url: string = '',
		frozen_fields_dict: FROZEN_FIELDS_DICT,
		data: FileData,
		context: string
	): AnkiConnectNoteAndID {
		return buildAnkiNote({
			template: data.template,
			modelName: this.note_type,
			fields: this.getFields(),
			tags: this.tags,
			identifier: this.identifier,
			deck,
			url,
			context,
			frozenFieldsDict: frozen_fields_dict,
			data,
			formatter: this.formatter
		})
	}
}
