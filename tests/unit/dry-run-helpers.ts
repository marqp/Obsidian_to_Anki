import { AllFile } from '../../src/file'
import { createFileData } from '../../src/scan-optimizations'
import type { ParsedSettings } from '../../src/interfaces/settings-interface'
import type { AnkiConnectNote } from '../../src/interfaces/note-interface'
import type { CachedMetadata } from 'obsidian'

export function createParsedSettings(): ParsedSettings {
	return {
		fields_dict: { Basic: ['Front', 'Back'], Cloze: ['Text'] },
		custom_regexps: {},
		file_link_fields: {},
		context_fields: {},
		template: {
			deckName: 'Default',
			modelName: '',
			fields: {},
			options: { allowDuplicate: true },
			tags: []
		},
		EXISTING_IDS: new Set<number>(),
		vault_name: 'test-vault',
		FROZEN_REGEXP: /FROZEN/g,
		DECK_REGEXP: /TARGET DECK/m,
		TAG_REGEXP: /FILE TAGS/m,
		NOTE_REGEXP: /START[\s\S]*?END/gm,
		INLINE_REGEXP: /STARTI.*?ENDI/g,
		EMPTY_REGEXP: /DELETE/g,
		curly_cloze: false,
		highlights_to_cloze: false,
		comment: true,
		add_context: false,
		add_obs_tags: false,
		add_file_link: false,
		folder_decks: {},
		folder_tags: {},
		ignored_file_globs: [],
		sync_to_ankiweb: false,
		delete_removed_notes: false,
		allow_note_type_changes: false
	}
}

export interface DryRunNoteSpec {
	id: number
	fields: Record<string, string>
	tags: string[]
	deck?: string
	model?: string
	cardIds?: number[]
}

export interface DryRunNewNoteSpec {
	deckName: string
	modelName: string
}

export interface DryRunScenario {
	notesInfo: unknown[]
	cardsInfo: unknown[]
}

/**
 * Build a scanned AllFile whose notes_to_edit match the given specs. Like a
 * real scan before its batch runs, it carries no deck map: the dry-run has to
 * derive card targets from its own notesInfo read.
 */
export function createManagerFiles(
	data: ParsedSettings,
	edits: DryRunNoteSpec[],
	adds: DryRunNewNoteSpec[]
): AllFile[] {
	const file = new AllFile('', 'dry-run.md', '', createFileData(data, 'Default', []), {} as CachedMetadata)
	file.global_tags = ''
	file.target_deck = 'Default'
	file.notes_to_add = adds.map((spec): AnkiConnectNote => ({
		deckName: spec.deckName,
		modelName: spec.modelName,
		fields: {},
		options: { allowDuplicate: true },
		tags: []
	}))
	file.all_notes_to_add = [...file.notes_to_add]
	file.notes_to_edit = edits.map((spec) => ({
		identifier: spec.id,
		note: {
			deckName: spec.deck ?? 'Default',
			modelName: spec.model ?? 'Basic',
			fields: { ...spec.fields },
			options: { allowDuplicate: true },
			tags: [...spec.tags]
		}
	}))
	return [file]
}
