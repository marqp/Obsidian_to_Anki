import { describe, it, expect, vi } from 'vitest'
import { pullOcclusions, replaceMasks, type OcclusionNote, type PullDependencies } from '../../src/occlusion-pull'
import { createFileData } from '../../src/scan-optimizations'
import { createParsedSettings } from './anki-test-helpers'

const FIELDS = ['Occlusion', 'Image', 'Header', 'Back Extra', 'Comments']
const data = createFileData(
	createParsedSettings({ fields_dict: { 'Image Occlusion': FIELDS, Basic: ['Front', 'Back'] } }),
	'Med',
	[]
)
const syntax = {
	beginNote: 'START',
	endNote: 'END',
	reservedWords: ['START', 'END', 'Tags: ', 'Occlusion:', 'Image:', 'Header:', 'Back Extra:', 'Comments:'],
	otherLabels: ['Tags: ', 'Image:', 'Header:', 'Back Extra:', 'Comments:']
}
const mask = (card: number, left = '.1'): string =>
	`{{c${card}::image-occlusion:rect:left=${left}:top=.2:width=.3:height=.1:oi=1}}`

function block(noteId: number, occlusion: string[], rest: string[] = ['Image: <img src="a.png">']): string {
	const [first, ...others] = occlusion
	return [
		'START',
		'Image Occlusion',
		`Occlusion: ${first}`,
		...others,
		...rest,
		`<!--ID: ${noteId}-->`,
		'END',
		''
	].join('\n')
}

function anki(noteId: number, occlusion: string, fields: Record<string, string> = {}): OcclusionNote {
	const values: Record<string, string> = { Occlusion: occlusion, Image: '<img src="a.png">', ...fields }
	return {
		noteId,
		modelName: 'Image Occlusion',
		fields: Object.fromEntries(Object.entries(values).map(([name, value], order) => [name, { value, order }]))
	}
}

function setup(files: Record<string, string>, notes: OcclusionNote[], scanning = false) {
	const vault = { ...files }
	const process = vi.fn(async (path: string, edit: (current: string) => string) => {
		vault[path] = edit(vault[path])
	})
	const source = new Map<number, string>()
	for (const [path, text] of Object.entries(files)) {
		for (const match of text.matchAll(/ID: (\d+)/g)) {
			source.set(parseInt(match[1], 10), path)
		}
	}
	const dependencies: PullDependencies = {
		isScanning: () => scanning,
		readNotes: vi.fn(async (noteIds?: number[]) =>
			noteIds === undefined ? notes : notes.filter((note) => noteIds.includes(note.noteId))
		),
		sourceOf: (noteId) => source.get(noteId),
		read: async (path) => vault[path] ?? null,
		cache: () => ({}),
		process,
		data,
		syntax
	}
	return { vault, process, dependencies }
}

describe('pullOcclusions', () => {
	it('lists only the notes whose masks differ, without writing', async () => {
		const { vault, process, dependencies } = setup(
			{ 'a.md': `TARGET DECK: Med\n\n${block(1, [mask(1)])}\n${block(2, [mask(1), mask(2)])}` },
			[anki(1, mask(1)), anki(2, `${mask(1)}<br>${mask(2, '.7')}`)]
		)
		const before = { ...vault }

		const result = await pullOcclusions({ apply: false }, dependencies)

		expect(result.differences).toEqual([
			{
				noteId: 2,
				file: 'a.md',
				line: 10,
				onlyInAnki: ['c2:rect:height=0.1:left=0.7:oi=1:top=0.2:width=0.3'],
				onlyInMarkdown: ['c2:rect:height=0.1:left=0.1:oi=1:top=0.2:width=0.3'],
				otherFieldsDiffer: []
			}
		])
		expect(process).not.toHaveBeenCalled()
		expect(vault).toEqual(before)
	})

	it('sees no difference where only the line breaks differ', async () => {
		const { dependencies } = setup({ 'a.md': block(1, [mask(1), mask(2)]) }, [anki(1, `${mask(1)}<br>${mask(2)}`)])

		expect((await pullOcclusions({ apply: false }, dependencies)).differences).toEqual([])
	})

	it('copies the masks of the named note and leaves everything else alone', async () => {
		const other = block(2, [mask(1)])
		const { vault, dependencies } = setup(
			{
				'a.md': `${block(1, [mask(1), mask(2)], ['Image: <img src="a.png">', 'Header: q'])}\n${other}`
			},
			[anki(1, `${mask(1, '.7')}<br>${mask(2)}<br>${mask(3)}`, { Header: 'q' }), anki(2, mask(1, '.9'))]
		)

		const result = await pullOcclusions({ noteIds: [1], apply: true }, dependencies)

		expect(result.pulled).toEqual([1])
		expect(vault['a.md']).toBe(
			`${block(1, [mask(1, '.7'), mask(2), mask(3)], ['Image: <img src="a.png">', 'Header: q'])}\n${other}`
		)
	})

	it('reports other fields that differ, and does not pull them', async () => {
		const original = block(1, [mask(1)], ['Image: <img src="a.png">', 'Header: old'])
		const { vault, dependencies } = setup({ 'a.md': original }, [anki(1, mask(1, '.7'), { Header: 'new' })])

		const result = await pullOcclusions({ noteIds: [1], apply: true }, dependencies)

		expect(result.differences[0].otherFieldsDiffer).toEqual(['Header'])
		expect(vault['a.md']).toContain('Header: old')
	})

	it('needs named notes to write', async () => {
		const { process, dependencies } = setup({ 'a.md': block(1, [mask(1)]) }, [anki(1, mask(1, '.7'))])

		const result = await pullOcclusions({ apply: true }, dependencies)

		expect(result.blocked[0]).toContain('noteIds')
		expect(process).not.toHaveBeenCalled()
	})

	it('waits for a running scan', async () => {
		const { dependencies } = setup({ 'a.md': block(1, [mask(1)]) }, [anki(1, mask(1, '.7'))], true)

		const result = await pullOcclusions({ noteIds: [1], apply: true }, dependencies)

		expect(result.blocked[0]).toContain('scan')
		expect(dependencies.readNotes).not.toHaveBeenCalled()
	})

	it('says which notes have no block in the vault', async () => {
		const { dependencies } = setup({}, [anki(9, mask(1))])

		expect((await pullOcclusions({ noteIds: [9, 10], apply: false }, dependencies)).notInVault).toEqual([9, 10])
	})

	it('treats a file that is gone as not in the vault', async () => {
		const { dependencies } = setup({ 'a.md': block(1, [mask(1)]) }, [anki(1, mask(1))])
		dependencies.read = async () => null

		expect((await pullOcclusions({ noteIds: [1], apply: false }, dependencies)).notInVault).toEqual([1])
	})

	it('skips notes of other types', async () => {
		const { dependencies } = setup({ 'a.md': block(1, [mask(1)]) }, [
			{ ...anki(1, mask(1, '.7')), modelName: 'Cloze' }
		])

		expect((await pullOcclusions({ apply: false }, dependencies)).differences).toEqual([])
	})

	it('reports a block it cannot edit, leaving the file as it was', async () => {
		const original = block(1, [mask(1)])
		const { vault, dependencies } = setup({ 'a.md': original }, [anki(1, `<table>${mask(1, '.7')}</table>`)])

		const result = await pullOcclusions({ noteIds: [1], apply: true }, dependencies)

		expect(result.pulled).toEqual([])
		expect(result.problems).toEqual([{ noteId: 1, reason: expect.stringContaining('no Markdown form') }])
		expect(vault['a.md']).toBe(original)
	})
})

describe('replaceMasks', () => {
	const field = mask(1, '.7')

	it.each([
		['an ID on two lines', `${block(1, [mask(1)])}\n${block(1, [mask(2)])}`, 'on 2 lines'],
		['no ID', block(2, [mask(1)]), 'on 0 lines'],
		['no end marker', block(1, [mask(1)]).replace('END\n', ''), 'marker'],
		['another note type', block(1, [mask(1)]).replace('Image Occlusion', 'Basic'), 'not an Image Occlusion'],
		['no mask label', block(1, [mask(1)]).replace('Occlusion: ', ''), '0 "Occlusion:" lines']
	])('refuses a file with %s', (_case, text, reason) => {
		expect(replaceMasks(text, 1, field, syntax)).toEqual({ problem: expect.stringContaining(reason) })
	})

	it('refuses an empty field, which would erase the masks', () => {
		expect(replaceMasks(block(1, [mask(1)]), 1, '', syntax)).toEqual({
			problem: expect.stringContaining('would not survive')
		})
	})

	it('keeps the labels after the masks in any order', () => {
		const text = block(1, [mask(1), mask(2)], ['Tags: a b', 'Image: ![[a.png]]'])

		expect(replaceMasks(text, 1, field, syntax)).toEqual({
			text: block(1, [field], ['Tags: a b', 'Image: ![[a.png]]'])
		})
	})

	it('handles a mask field right before the ID', () => {
		const text = block(1, [mask(1), mask(2)], [])

		expect(replaceMasks(text, 1, field, syntax)).toEqual({ text: block(1, [field], []) })
	})
})
