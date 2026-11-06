export interface AnkiConnectNote {
	deckName: string
	modelName: string
	fields: Record<string, string>
	options:
		| {
				allowDuplicate: true
		  }
		| {
				allowDuplicate: false
				duplicateScope: string
		  }
	tags: Array<string>
}

export interface AnkiConnectNoteAndID {
	note: AnkiConnectNote
	identifier: number | null
}

/**
 * Why a parsed block is not sent: a Cloze or Image Occlusion note with nothing
 * to ask, or a note type the fields dictionary does not have. The block keeps
 * its own ID in `identifier`.
 */
type NoteProblem = 'missing-cloze' | 'unknown-type'

/** What parsing a block gives: the note, its ID, and why it is not sent, if it is not. */
export interface ParsedNote extends AnkiConnectNoteAndID {
	problem?: NoteProblem
}
