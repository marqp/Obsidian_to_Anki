export interface AnkiConnectNote {
	deckName: string,
	modelName: string,
	fields: Record<string, string>,
	options: {
		allowDuplicate: true
	} | {
		allowDuplicate: false
		duplicateScope: string
	}
	tags: Array<string>,
}

export interface AnkiConnectNoteAndID {
	note: AnkiConnectNote,
	identifier: number | null
}
