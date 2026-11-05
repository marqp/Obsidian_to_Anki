/**
 * Copies masks adjusted in Anki's editor back to the Markdown, which owns the
 * note: without this, the next scan of that file would undo the adjustment.
 * Changes one field of one block, and nothing in Anki.
 */
import { AllFile } from './file'
import { canonicalHtml, htmlToMarkdown, protectLineStarts } from './html-to-markdown'
import type { FileData } from './interfaces/settings-interface'
import { canonicalMasks, maskDifferences } from './occlusion'
import type { CachedMetadata } from 'obsidian'

const NOTE_TYPE = 'Image Occlusion'
const MASK_FIELD = 'Occlusion'

export interface OcclusionNote {
	noteId: number
	modelName: string
	fields: Record<string, { value: string; order: number }>
}

interface OcclusionDifference {
	noteId: number
	file: string
	line?: number
	/** Masks Anki has and the Markdown does not, and the opposite. */
	onlyInAnki: string[]
	onlyInMarkdown: string[]
	/** Other fields that also differ. A pull leaves them as they are. */
	otherFieldsDiffer: string[]
}

export interface OcclusionPullResult {
	blocked: string[]
	differences: OcclusionDifference[]
	/** Requested notes with no block in the vault, as of each file's last scan. */
	notInVault: number[]
	pulled: number[]
	problems: Array<{ noteId: number; reason: string }>
}

export interface PullSyntax {
	beginNote: string
	endNote: string
	/** Line starts the block parser reads as structure. */
	reservedWords: string[]
	/** Labels that end the mask field: the other fields of the type, and `Tags:`. */
	otherLabels: string[]
}

export interface PullDependencies {
	isScanning(): boolean
	readNotes(noteIds?: number[]): Promise<OcclusionNote[]>
	sourceOf(noteId: number): string | undefined
	read(path: string): Promise<string | null>
	cache(path: string): CachedMetadata
	/** Rewrites a file atomically; `edit` returning the same text changes nothing. */
	process(path: string, edit: (current: string) => string): Promise<void>
	data: FileData
	syntax: PullSyntax
}

function differencesInFile(
	path: string,
	text: string,
	notes: ReadonlyMap<number, OcclusionNote>,
	cache: CachedMetadata,
	data: FileData
): OcclusionDifference[] {
	const file = new AllFile(text, path, '', { ...data, EXISTING_IDS: new Set(notes.keys()) }, cache)
	file.scanFile()
	const differences: OcclusionDifference[] = []
	for (const parsed of file.notes_to_edit) {
		const note = parsed.identifier === null ? undefined : notes.get(parsed.identifier)
		if (note === undefined || parsed.note.modelName !== NOTE_TYPE) {
			continue
		}
		const { onlyInFirst: onlyInAnki, onlyInSecond: onlyInMarkdown } = maskDifferences(
			note.fields[MASK_FIELD]?.value ?? '',
			parsed.note.fields[MASK_FIELD] ?? ''
		)
		if (onlyInAnki.length === 0 && onlyInMarkdown.length === 0) {
			continue
		}
		const line = file.editedNoteLine(note.noteId)
		differences.push({
			noteId: note.noteId,
			file: path,
			...(line === undefined ? {} : { line }),
			onlyInAnki,
			onlyInMarkdown,
			otherFieldsDiffer: Object.keys(parsed.note.fields).filter(
				(name) =>
					name !== MASK_FIELD &&
					canonicalHtml(parsed.note.fields[name]) !== canonicalHtml(note.fields[name]?.value ?? '')
			)
		})
	}
	return differences
}

/** The block's lines, or why it cannot be edited safely. */
function findBlock(
	lines: string[],
	noteId: number,
	syntax: PullSyntax
): { begin: number; end: number } | { problem: string } {
	const idLine = new RegExp(`^(?:<!--)?ID: ${noteId}\\b`)
	const matches = lines.flatMap((line, index) => (idLine.test(line) ? [index] : []))
	if (matches.length !== 1) {
		return { problem: `its ID is on ${matches.length} lines of the file, not 1` }
	}
	const begin = lines.lastIndexOf(syntax.beginNote, matches[0])
	const end = lines.indexOf(syntax.endNote, matches[0])
	if (begin === -1 || end === -1) {
		return { problem: 'its block has no begin or end marker' }
	}
	if (lines[begin + 1]?.trim() !== NOTE_TYPE) {
		return { problem: `its block is not an ${NOTE_TYPE} note` }
	}
	return { begin, end }
}

/** The file with this note's masks replaced by Anki's, or why it was left alone. */
export function replaceMasks(
	text: string,
	noteId: number,
	ankiField: string,
	syntax: PullSyntax
): { text: string } | { problem: string } {
	const converted = htmlToMarkdown(ankiField)
	if (converted.unsupported.length > 0) {
		return { problem: `its masks hold HTML with no Markdown form: ${converted.unsupported.join(', ')}` }
	}
	if (converted.markdown === '' || canonicalMasks(converted.markdown).join() !== canonicalMasks(ankiField).join()) {
		return { problem: 'its masks would not survive being written as Markdown' }
	}
	const lines = text.split('\n')
	const block = findBlock(lines, noteId, syntax)
	if ('problem' in block) {
		return block
	}
	const label = `${MASK_FIELD}:`
	const starts: number[] = []
	for (let index = block.begin + 2; index < block.end; index++) {
		if (lines[index].startsWith(label)) {
			starts.push(index)
		}
	}
	if (starts.length !== 1) {
		return { problem: `its block has ${starts.length} "${label}" lines, not 1` }
	}
	const start = starts[0]
	let stop = start + 1
	const ends = (line: string): boolean =>
		/^(?:<!--)?ID: \d+/.test(line) || syntax.otherLabels.some((other) => line.startsWith(other))
	while (stop < block.end && !ends(lines[stop])) {
		stop++
	}
	const replacement = `${label} ${protectLineStarts(converted.markdown, syntax.reservedWords)}`.split('\n')
	return { text: [...lines.slice(0, start), ...replacement, ...lines.slice(stop)].join('\n') }
}

/**
 * Lists the occlusions whose masks differ between Anki and the Markdown and,
 * when asked, copies Anki's masks over. Writing needs named notes: the difference
 * may be an edit made in the Markdown, and only the person knows which side is right.
 */
export async function pullOcclusions(
	request: { noteIds?: number[]; apply: boolean },
	dependencies: PullDependencies
): Promise<OcclusionPullResult> {
	const result: OcclusionPullResult = { blocked: [], differences: [], notInVault: [], pulled: [], problems: [] }
	if (request.apply && (request.noteIds === undefined || request.noteIds.length === 0)) {
		result.blocked.push('Say which notes to pull: "noteIds" is required with "apply".')
		return result
	}
	if (dependencies.isScanning()) {
		result.blocked.push('A scan is running. Try again when it ends.')
		return result
	}
	const notes = (await dependencies.readNotes(request.noteIds)).filter((note) => note.modelName === NOTE_TYPE)
	const byFile = new Map<string, Map<number, OcclusionNote>>()
	for (const note of notes) {
		const path = dependencies.sourceOf(note.noteId)
		if (path !== undefined) {
			byFile.set(path, (byFile.get(path) ?? new Map<number, OcclusionNote>()).set(note.noteId, note))
		}
	}
	const found = new Set<number>()
	for (const [path, inFile] of byFile) {
		const text = await dependencies.read(path)
		if (text === null) {
			continue
		}
		inFile.forEach((_note, noteId) => found.add(noteId))
		result.differences.push(...differencesInFile(path, text, inFile, dependencies.cache(path), dependencies.data))
	}
	if (request.noteIds !== undefined) {
		result.notInVault = request.noteIds.filter((noteId) => !found.has(noteId))
	}
	if (request.apply) {
		for (const difference of result.differences) {
			await pullOne(difference, byFile, dependencies, result)
		}
	}
	return result
}

async function pullOne(
	difference: OcclusionDifference,
	byFile: ReadonlyMap<string, ReadonlyMap<number, OcclusionNote>>,
	dependencies: PullDependencies,
	result: OcclusionPullResult
): Promise<void> {
	const { noteId, file } = difference
	const ankiField = byFile.get(file)?.get(noteId)?.fields[MASK_FIELD]?.value ?? ''
	let problem: string | undefined
	await dependencies.process(file, (current) => {
		const replaced = replaceMasks(current, noteId, ankiField, dependencies.syntax)
		if ('problem' in replaced) {
			problem = replaced.problem
			return current
		}
		return replaced.text
	})
	if (problem === undefined) {
		result.pulled.push(noteId)
	} else {
		result.problems.push({ noteId, reason: problem })
	}
}
