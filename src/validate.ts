import { AllFile } from './file'
import type { ScanIssue } from './files-manager'
import type { FileData } from './interfaces/settings-interface'
import { escapeRegex } from './constants'

type ValidationKind =
	| Extract<
			ScanIssue['kind'],
			| 'cloze-without-deletions'
			| 'occlusion-image-missing'
			| 'unknown-note-type'
			| 'stale-note-id'
			| 'duplicate-note-id'
	  >
	| 'unterminated-block'
	| 'end-marker-collision'
	| 'literal-field-label'
	| 'missing-back-label'

interface ValidationIssue {
	file: string
	kind: ValidationKind
	/** error: the card is missing or wrong in Anki. warning: worth a look. */
	severity: 'error' | 'warning'
	message: string
	line?: number
	snippet?: string
	noteId?: number
}

export interface ValidationReport {
	filesChecked: number
	blocks: number
	errors: number
	warnings: number
	/** False when Anki was closed: IDs were not checked against it. */
	ankiChecked: boolean
	byKind: Partial<Record<ValidationKind, number>>
	issues: ValidationIssue[]
}

export interface ValidationInput {
	path: string
	text: string
	data: FileData
}

export interface ValidationOptions {
	beginNote: string
	/** Note IDs Anki knows; omitted when Anki cannot be asked. */
	existingIds?: ReadonlySet<number>
}

const ID_PATTERN = /(?:<!--)?ID: (\d+)/g
const SNIPPET_LENGTH = 100

function lineAt(text: string, position: number): number {
	return text.slice(0, position).split('\n').length
}

function snippetOf(text: string): string {
	return text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LENGTH)
}

function idsIn(text: string): Set<number> {
	return new Set(Array.from(text.matchAll(ID_PATTERN), (match) => parseInt(match[1], 10)))
}

/** Problems visible in the block structure, which the parser reads past silently. */
function structuralIssues(input: ValidationInput, beginNote: string): { issues: ValidationIssue[]; blocks: number } {
	const { path, text, data } = input
	const issues: ValidationIssue[] = []
	const beginLine = new RegExp(`^${escapeRegex(beginNote)}[ ]*$`, 'gm')
	const blockSpans: Array<[number, number]> = []
	const allFields = new Set(Object.values(data.fields_dict).flat())
	for (const match of text.matchAll(data.NOTE_REGEXP)) {
		const end = match.index + match[0].length
		blockSpans.push([match.index, end])
		const body = match[1]
		const next = text[end]
		if (next !== undefined && next !== '\n' && next !== '\r') {
			issues.push({
				file: path,
				kind: 'end-marker-collision',
				severity: 'error',
				message:
					'A line starting with the end marker closed this block early, so the text after it is lost. Reword the line.',
				line: lineAt(text, end),
				snippet: snippetOf(body)
			})
		}
		const nested = new RegExp(`^${escapeRegex(beginNote)}[ ]*$`, 'm').exec(body)
		if (nested) {
			issues.push({
				file: path,
				kind: 'unterminated-block',
				severity: 'error',
				message: 'This block has no end marker before the next one starts, so the two became one card.',
				line: lineAt(text, match.index),
				snippet: snippetOf(body)
			})
		}
		const lines = body.split('\n')
		const fields = data.fields_dict[lines[0].trim()]
		if (!fields) {
			continue
		}
		// Lines without a label stay in the field above, so a Basic block with no
		// "Back:" line puts its answer on the front and makes a card with no back.
		// A block that swallowed the next one is already reported, and its labels prove nothing.
		if (!nested && fields[1] === 'Back' && !lines.some((line) => line.startsWith('Back:'))) {
			issues.push({
				file: path,
				kind: 'missing-back-label',
				severity: 'warning',
				message: `No line starts with "Back:", so the whole block went to ${fields[0]} and the card has no answer. Start the answer with "Back:".`,
				line: lineAt(text, match.index),
				snippet: snippetOf(body)
			})
		}
		const foreign = [...allFields].filter((name) => !fields.includes(name))
		lines.slice(1).forEach((line, index) => {
			const label = foreign.find((name) => line.startsWith(`${name}:`))
			if (label !== undefined) {
				issues.push({
					file: path,
					kind: 'literal-field-label',
					severity: 'warning',
					message: `"${label}:" is not a field of ${lines[0].trim()}, so it appears as literal text on the card.`,
					line: lineAt(text, match.index) + index + 2,
					snippet: snippetOf(line)
				})
			}
		})
	}
	for (const match of text.matchAll(beginLine)) {
		if (!blockSpans.some(([start, end]) => match.index >= start && match.index < end)) {
			issues.push({
				file: path,
				kind: 'unterminated-block',
				severity: 'error',
				message: 'This block has no end marker, so it is ignored.',
				line: lineAt(text, match.index),
				snippet: snippetOf(text.slice(match.index, match.index + SNIPPET_LENGTH))
			})
		}
	}
	return { issues, blocks: blockSpans.length }
}

/** The real parser, so validation can never disagree with what a scan does. */
function parseWithRealScanner(input: ValidationInput, existingIds: ReadonlySet<number> | undefined): AllFile {
	// Without Anki every ID in the text counts as known: an ID can then only be
	// flagged for being duplicated, not for being missing from a collection
	// nobody could ask.
	const known = existingIds ?? idsIn(input.text)
	const file = new AllFile(input.text, input.path, '', { ...input.data, EXISTING_IDS: new Set(known) }, {})
	file.scanFile()
	return file
}

const PARSER_KINDS: ReadonlySet<string> = new Set([
	'cloze-without-deletions',
	'occlusion-image-missing',
	'unknown-note-type',
	'stale-note-id',
	'duplicate-note-id'
])

/**
 * Check card syntax without changing anything and regardless of whether a file
 * changed since its last scan. Works with Anki closed, except for telling IDs
 * Anki no longer knows.
 */
export function validateFiles(inputs: ValidationInput[], options: ValidationOptions): ValidationReport {
	const issues: ValidationIssue[] = []
	const filesById = new Map<number, Array<{ path: string; text: string }>>()
	let blocks = 0
	for (const input of inputs) {
		const structure = structuralIssues(input, options.beginNote)
		blocks += structure.blocks
		issues.push(...structure.issues)
		const file = parseWithRealScanner(input, options.existingIds)
		for (const issue of file.parseIssues) {
			if (PARSER_KINDS.has(issue.kind)) {
				issues.push({
					file: issue.file,
					kind: issue.kind as ValidationKind,
					severity: 'error',
					message: issue.error,
					line: issue.line,
					snippet: issue.snippet,
					...(issue.noteId === undefined ? {} : { noteId: issue.noteId })
				})
			}
		}
		for (const id of new Set(file.getNoteIdsInFile())) {
			filesById.set(id, [...(filesById.get(id) ?? []), { path: input.path, text: input.text }])
		}
	}
	for (const [noteId, files] of filesById) {
		if (files.length < 2) {
			continue
		}
		const paths = files.map((file) => file.path)
		for (const { path, text } of files) {
			const position = text.search(new RegExp(`ID: ${noteId}\\b`))
			issues.push({
				file: path,
				kind: 'duplicate-note-id',
				severity: 'error',
				message: `Note ID ${noteId} is used in ${paths.length} files (${paths.join(', ')}), so they overwrite the same Anki note.`,
				line: lineAt(text, position),
				noteId
			})
		}
	}
	const byKind: ValidationReport['byKind'] = {}
	for (const issue of issues) {
		byKind[issue.kind] = (byKind[issue.kind] ?? 0) + 1
	}
	const errors = issues.filter((issue) => issue.severity === 'error').length
	return {
		filesChecked: inputs.length,
		blocks,
		errors,
		warnings: issues.length - errors,
		ankiChecked: options.existingIds !== undefined,
		byKind,
		issues
	}
}
