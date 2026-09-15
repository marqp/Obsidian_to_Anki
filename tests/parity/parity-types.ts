/** Canonical per-fixture output of one engine side. Compared structurally. */
export interface ParityCard {
	deck: string
	model: string
	fields: Record<string, string>
	tags: string[]
}

export interface ParityEdit extends ParityCard {
	id: number
}

export interface ParityInsert {
	path: string
	id: number
}

export interface ParityWarning {
	category: 'unknown-id' | 'unknown-model' | 'cloze-skip' | 'other'
	count: number
}

export interface ParityOutput {
	adds: ParityCard[]
	edits: ParityEdit[]
	deletes: number[]
	/** IDs the engine stamped into the Markdown, in file order. */
	inserts: ParityInsert[]
	finalMarkdown: Record<string, string>
	warnings: ParityWarning[]
	errors: string[]
}

export interface ParityFixtureFile {
	path: string
	content: string
}

export interface ParityFixture {
	files: ParityFixtureFile[]
	storedNoteIds: Record<string, number[]>
}
