/**
 * Plans bringing notes that exist only in Anki into the vault, keeping their
 * note IDs and so their scheduling. Read-only: it asks Anki and returns text,
 * and writes nothing to Anki or the vault.
 */
import * as AnkiConnect from './anki'
import { AllFile } from './file'
import { canonicalHtml, htmlToMarkdown, protectLineStarts } from './html-to-markdown'
import type { FileData } from './interfaces/settings-interface'
import { inBatches } from './anki-read'
import { validateFiles } from './validate'
import type { CachedMetadata } from 'obsidian'

/** Their masks and generated fields have no Markdown form. */
const LEFT_IN_ANKI = /image occlusion|overlapping/i
/** Anki's own markers say nothing about a card's subject. */
const STATUS_TAGS: ReadonlySet<string> = new Set(['leech', 'marked'])
const MAX_NOTES_PER_FILE = 150
const MIN_NOTES_PER_FILE = 30
/** Note IDs are creation times, so a long pause separates study sessions. */
const SESSION_GAP_MS = 6 * 60 * 60 * 1000
const BATCH_SIZE = 500
const SNIPPET_LENGTH = 100
const UNTAGGED = 'Sem tag'

export interface ImportableNote {
	noteId: number
	modelName: string
	tags: string[]
	fields: Record<string, { value: string; order: number }>
	cards: number[]
}

export interface ImportOptions {
	/** Where the new files go, inside a scanned folder. */
	folder: string
	defaultDeck: string
	beginNote: string
	/** Line starts the block parser reads as structure. */
	reservedWords: string[]
	dataFor(deck: string): FileData
}

interface ImportFile {
	path: string
	deck: string
	noteIds: number[]
	text: string
}

interface RefusedNote {
	noteId: number
	modelName: string
	/** What would not survive the round trip. */
	reasons: string[]
	snippet: string
}

export interface ImportPlan {
	files: ImportFile[]
	refused: RefusedNote[]
	/** Local image names the new files embed; each must be in the vault to display. */
	images: string[]
	externalImages: number
	/** Notes that pass but would change looks only, by what changes. */
	cosmeticChanges: { imageWidth: number; imageAlt: number; inlineStyle: number }
	/** Problems the validator finds in the final files. Must be zero before writing. */
	structuralErrors: number
}

export interface ImportPreview extends Omit<ImportPlan, 'files' | 'images'> {
	candidates: number
	ready: number
	leftInAnki: Record<string, number>
	files: Array<{ path: string; deck: string; notes: number }>
	imageCount: number
}

function fieldsInOrder(note: ImportableNote): Array<[string, string]> {
	return Object.entries(note.fields)
		.sort(([, a], [, b]) => a.order - b.order)
		.map(([name, field]) => [name, field.value])
}

function allFields(note: ImportableNote): string {
	return fieldsInOrder(note)
		.map(([, value]) => value)
		.join(' ')
}

function snippetOf(note: ImportableNote): string {
	return allFields(note)
		.replace(/<[^>]*>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, SNIPPET_LENGTH)
}

function noteBlock(note: ImportableNote, reservedWords: string[]): { text: string; unsupported: string[] } {
	const lines = [note.modelName]
	const unsupported: string[] = []
	for (const [name, html] of fieldsInOrder(note)) {
		const converted = htmlToMarkdown(html)
		unsupported.push(...converted.unsupported)
		if (converted.markdown !== '') {
			lines.push(`${name}: ${protectLineStarts(converted.markdown, reservedWords)}`)
		}
	}
	if (note.tags.length > 0) {
		lines.push(`Tags: ${note.tags.join(' ')}`)
	}
	lines.push(`<!--ID: ${note.noteId}-->`)
	return { text: `START\n${lines.join('\n')}\nEND\n`, unsupported: [...new Set(unsupported)] }
}

/** What Obsidian's cache will hold for these embeds once the file exists. */
function embedsCache(text: string): CachedMetadata {
	const embeds = Array.from(text.matchAll(/!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g), (match) => ({
		original: match[0],
		link: match[1],
		displayText: match[2] ?? match[1]
	}))
	return { embeds } as unknown as CachedMetadata
}

function fileText(deck: string, blocks: string[]): string {
	return `TARGET DECK: ${deck}\n\n${blocks.join('\n')}`
}

/** Runs the file through the real scanner and says what differs for each note. */
function roundTripProblems(file: ImportFile, notes: ImportableNote[], data: FileData): Map<number, string[]> {
	const parsed = new AllFile(
		file.text,
		file.path,
		'',
		{ ...data, EXISTING_IDS: new Set(file.noteIds) },
		embedsCache(file.text)
	)
	parsed.scanFile()
	const byId = new Map(parsed.notes_to_edit.map((entry) => [entry.identifier, entry.note]))
	const problems = new Map<number, string[]>()
	for (const note of notes) {
		const result = byId.get(note.noteId)
		if (result === undefined) {
			problems.set(note.noteId, ['not read back by the parser'])
			continue
		}
		const reasons: string[] = []
		if (result.modelName !== note.modelName) {
			reasons.push('note type')
		}
		if (result.deckName !== file.deck) {
			reasons.push('deck')
		}
		const tags = result.tags.filter((tag) => tag !== '')
		if ([...tags].sort().join(' ') !== [...note.tags].sort().join(' ')) {
			reasons.push('tags')
		}
		for (const [name, html] of fieldsInOrder(note)) {
			if (canonicalHtml(result.fields[name] ?? '') !== canonicalHtml(html)) {
				reasons.push(`field ${name}`)
			}
		}
		if (reasons.length > 0) {
			problems.set(note.noteId, reasons)
		}
	}
	return problems
}

/** The note's subject: its most used tag across the import, at the top of a hierarchy. */
function mainTags(notes: ImportableNote[]): Map<number, string> {
	const rootOf = (tag: string): string => tag.split('::')[0]
	const uses = new Map<string, number>()
	const display = new Map<string, string>()
	for (const note of notes) {
		for (const tag of note.tags) {
			const key = rootOf(tag).toLowerCase()
			if (!STATUS_TAGS.has(key)) {
				uses.set(key, (uses.get(key) ?? 0) + 1)
				display.set(key, display.get(key) ?? rootOf(tag))
			}
		}
	}
	const main = new Map<number, string>()
	for (const note of notes) {
		const keys = note.tags.map((tag) => rootOf(tag).toLowerCase()).filter((key) => !STATUS_TAGS.has(key))
		const best = keys.sort((a, b) => (uses.get(b) ?? 0) - (uses.get(a) ?? 0) || a.localeCompare(b))[0]
		main.set(note.noteId, best === undefined ? UNTAGGED : (display.get(best) ?? best))
	}
	return main
}

/** Splits a subject that is too big for one file, at pauses between study sessions. */
function chunkBySession(notes: ImportableNote[]): ImportableNote[][] {
	const sorted = [...notes].sort((a, b) => a.noteId - b.noteId)
	const chunks: ImportableNote[][] = []
	let current: ImportableNote[] = []
	for (const note of sorted) {
		const previous = current[current.length - 1]
		const pause = previous !== undefined && note.noteId - previous.noteId > SESSION_GAP_MS
		if (current.length >= MAX_NOTES_PER_FILE || (pause && current.length >= MIN_NOTES_PER_FILE)) {
			chunks.push(current)
			current = []
		}
		current.push(note)
	}
	if (current.length > 0) {
		chunks.push(current)
	}
	return chunks
}

function safeName(name: string): string {
	return name
		.replace(/[/\\:*?"<>|#^[\]]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

function groupIntoFiles(
	notes: ImportableNote[],
	deckOf: (note: ImportableNote) => string,
	options: ImportOptions
): Array<{ path: string; deck: string; notes: ImportableNote[] }> {
	const main = mainTags(notes)
	const groups = new Map<string, ImportableNote[]>()
	for (const note of notes) {
		const key = JSON.stringify([deckOf(note), main.get(note.noteId)])
		groups.set(key, [...(groups.get(key) ?? []), note])
	}
	const files: Array<{ path: string; deck: string; notes: ImportableNote[] }> = []
	const used = new Set<string>()
	for (const [key, group] of groups) {
		const [deck, subject] = JSON.parse(key) as [string, string]
		const folder = deck === options.defaultDeck ? options.folder : `${options.folder}/${safeName(deck)}`
		const chunks = chunkBySession(group)
		for (const chunk of chunks) {
			const date = new Date(chunk[0].noteId).toISOString().slice(0, 10)
			const base = `${folder}/${safeName(subject)}${chunks.length > 1 ? ` ${date}` : ''}`
			let path = `${base}.md`
			for (let copy = 2; used.has(path); copy++) {
				path = `${base} (${copy}).md`
			}
			used.add(path)
			files.push({ path, deck, notes: chunk })
		}
	}
	return files
}

/** Everything but the notes' retrieval: pure, so its decisions can be tested. */
export function buildImportPlan(
	notes: ImportableNote[],
	deckByCard: ReadonlyMap<number, string>,
	options: ImportOptions
): ImportPlan {
	const refused = new Map<number, string[]>()
	const convertible: ImportableNote[] = []
	const decks = new Map<number, string>()
	const blocks = new Map<number, string>()
	for (const note of notes) {
		const noteDecks = new Set(note.cards.map((card) => deckByCard.get(card)))
		const block = noteBlock(note, options.reservedWords)
		const [deck] = noteDecks
		if (noteDecks.size !== 1 || deck === undefined) {
			refused.set(note.noteId, ['cards in more than one deck'])
		} else if (block.unsupported.length > 0) {
			refused.set(
				note.noteId,
				block.unsupported.map((tag) => `no Markdown form for ${tag}`)
			)
		} else {
			decks.set(note.noteId, deck)
			blocks.set(note.noteId, block.text)
			convertible.push(note)
		}
	}
	const files: ImportFile[] = []
	const ready: ImportableNote[] = []
	for (const group of groupIntoFiles(convertible, (note) => decks.get(note.noteId) ?? '', options)) {
		const data = options.dataFor(group.deck)
		const draft: ImportFile = {
			path: group.path,
			deck: group.deck,
			noteIds: group.notes.map((note) => note.noteId),
			text: fileText(
				group.deck,
				group.notes.map((note) => blocks.get(note.noteId) ?? '')
			)
		}
		const problems = roundTripProblems(draft, group.notes, data)
		for (const [noteId, reasons] of problems) {
			refused.set(noteId, reasons)
		}
		const kept = group.notes.filter((note) => !problems.has(note.noteId))
		if (kept.length > 0) {
			ready.push(...kept)
			files.push({
				...draft,
				noteIds: kept.map((note) => note.noteId),
				text: fileText(
					group.deck,
					kept.map((note) => blocks.get(note.noteId) ?? '')
				)
			})
		}
	}
	const report = validateFiles(
		files.map((file) => ({ path: file.path, text: file.text, data: options.dataFor(file.deck) })),
		{ beginNote: options.beginNote, existingIds: new Set(ready.map((note) => note.noteId)) }
	)
	const sources = ready.flatMap((note) =>
		Array.from(allFields(note).matchAll(/<img\b[^>]*?\bsrc="([^"]+)"/gi), (match) => match[1])
	)
	const isExternal = (src: string): boolean => /^[a-z][a-z\d+.-]*:/i.test(src)
	const usesAttribute = (pattern: RegExp): number => ready.filter((note) => pattern.test(allFields(note))).length
	return {
		files,
		refused: notes
			.filter((note) => refused.has(note.noteId))
			.map((note) => ({
				noteId: note.noteId,
				modelName: note.modelName,
				reasons: refused.get(note.noteId) ?? [],
				snippet: snippetOf(note)
			})),
		images: [...new Set(sources.filter((src) => !isExternal(src)))],
		externalImages: new Set(sources.filter(isExternal)).size,
		cosmeticChanges: {
			imageWidth: usesAttribute(/<img\b[^>]*\bwidth="?[^\d"]/i),
			imageAlt: usesAttribute(/<img\b[^>]*\balt="[^"]/i),
			inlineStyle: usesAttribute(/\bstyle=/i)
		},
		structuralErrors: report.errors
	}
}

/** Asks Anki which notes the vault does not hold yet, and plans their import. */
export async function previewImport(trackedIds: ReadonlySet<number>, options: ImportOptions): Promise<ImportPreview> {
	const ids = await AnkiConnect.invoke<number[]>('findNotes', { query: '' })
	const untracked = ids.filter((id) => !trackedIds.has(id))
	const notes = await inBatches(untracked, BATCH_SIZE, (batch) =>
		AnkiConnect.invoke<ImportableNote[]>('notesInfo', { notes: batch })
	)
	const leftInAnki: Record<string, number> = {}
	const candidates: ImportableNote[] = []
	for (const note of notes) {
		if (LEFT_IN_ANKI.test(note.modelName)) {
			leftInAnki[note.modelName] = (leftInAnki[note.modelName] ?? 0) + 1
		} else {
			candidates.push(note)
		}
	}
	const cards = await inBatches(
		candidates.flatMap((note) => note.cards),
		BATCH_SIZE,
		(batch) => AnkiConnect.invoke<Array<{ cardId: number; deckName: string }>>('cardsInfo', { cards: batch })
	)
	const plan = buildImportPlan(candidates, new Map(cards.map((card) => [card.cardId, card.deckName])), options)
	const { files, images, ...rest } = plan
	return {
		...rest,
		candidates: candidates.length,
		ready: files.reduce((sum, file) => sum + file.noteIds.length, 0),
		leftInAnki,
		files: files.map((file) => ({ path: file.path, deck: file.deck, notes: file.noteIds.length })),
		imageCount: images.length
	}
}
