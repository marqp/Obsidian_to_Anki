import { describe, it, expect } from 'vitest'
import {
	formatChangeLine,
	formatDeckLine,
	groupDryRunChanges,
	isZeroingPlan,
	type DryRunGroup
} from '../../src/dry-run-view'
import type { DryRunSummary } from '../../src/dry-run'

function summaryWith(
	changes: DryRunSummary['changes'],
	counts: Partial<Pick<DryRunSummary, 'wouldAdd' | 'wouldUpdate' | 'wouldDelete' | 'wouldConvert'>> = {}
): DryRunSummary {
	return {
		filesChanged: 1,
		filesTotal: 1,
		wouldAdd: 0,
		wouldUpdate: 0,
		wouldDelete: 0,
		wouldConvert: 0,
		decks: [],
		...counts,
		changes
	}
}

describe('groupDryRunChanges', () => {
	it('groups per file, deletes first, then converts, updates, adds', () => {
		const groups = groupDryRunChanges(
			summaryWith([
				{ kind: 'add', file: 'b.md', deck: 'D', modelName: 'Basic' },
				{ kind: 'update', file: 'a.md', noteId: 9, deck: 'D', modelName: 'Basic', fields: ['Front'] },
				{ kind: 'delete', file: 'a.md', noteId: 3 },
				{ kind: 'convert', file: 'a.md', noteId: 5, fromModel: 'Basic', toModel: 'Cloze' },
				{ kind: 'update', file: 'a.md', noteId: 2, deck: 'D', modelName: 'Basic', fields: ['Back'] }
			])
		)
		expect(groups.map((g: DryRunGroup) => g.displayFile)).toEqual(['a.md', 'b.md'])
		expect(groups[0].entries.map((e) => e.kind)).toEqual(['delete', 'convert', 'update', 'update'])
		expect(groups[0].entries.map((e) => e.noteId)).toEqual([3, 5, 2, 9])
	})

	it('sorts groups and null ids deterministically (comparator pin)', () => {
		const groups = groupDryRunChanges(
			summaryWith([
				{ kind: 'add', file: 'd.md', deck: 'D', modelName: 'Basic' },
				{ kind: 'update', file: 'c.md', noteId: 9, deck: 'D', modelName: 'Basic', fields: ['Front'] },
				{ kind: 'update', file: 'c.md', deck: 'D', modelName: 'Basic', fields: ['Back'] },
				{ kind: 'add', file: 'a.md', deck: 'D', modelName: 'Basic' },
				{ kind: 'delete', file: 'b.md', noteId: 1 }
			])
		)
		expect(groups.map((g: DryRunGroup) => g.displayFile)).toEqual(['a.md', 'b.md', 'c.md', 'd.md'])
		// Null ids sort before numbered ones inside the same kind.
		expect(groups[2].entries.map((e) => e.noteId)).toEqual([undefined, 9])
	})

	it('buckets unattributed orphans under (unknown file)', () => {
		const groups = groupDryRunChanges(summaryWith([{ kind: 'delete', file: '', noteId: 41 }]))
		expect(groups).toHaveLength(1)
		expect(groups[0].file).toBe('')
		expect(groups[0].displayFile).toBe('(unknown file)')
	})

	it('returns no groups for an empty plan', () => {
		expect(groupDryRunChanges(summaryWith([]))).toEqual([])
	})
})

describe('formatChangeLine', () => {
	it('formats every kind with missing-field tolerance', () => {
		expect(formatChangeLine({ kind: 'add', file: 'f', deck: 'D', modelName: 'Basic' })).toBe('+ D/Basic')
		expect(
			formatChangeLine({
				kind: 'update',
				file: 'f',
				noteId: 5,
				deck: 'D',
				modelName: 'B',
				fields: ['Front', 'Back']
			})
		).toBe('~ #5 D (Front, Back)')
		expect(formatChangeLine({ kind: 'delete', file: 'f', noteId: 7 })).toBe('- #7')
		expect(formatChangeLine({ kind: 'convert', file: 'f', noteId: 8, fromModel: 'A', toModel: 'B' })).toBe(
			'⇄ #8 A→B'
		)
		expect(formatChangeLine({ kind: 'convert', file: 'f', noteId: 8, fromModel: 'A' })).toBe('⇄ #8 A→')
		expect(formatChangeLine({ kind: 'add', file: 'f' })).toBe('+ /')
		expect(formatChangeLine({ kind: 'update', file: 'f' })).toBe('~ #?  ()')
	})
})

describe('isZeroingPlan', () => {
	it('is true only for deletes-with-nothing-else', () => {
		expect(isZeroingPlan(summaryWith([], { wouldDelete: 2 }))).toBe(true)
		expect(isZeroingPlan(summaryWith([], { wouldDelete: 2, wouldAdd: 1 }))).toBe(false)
		expect(isZeroingPlan(summaryWith([], { wouldDelete: 2, wouldUpdate: 1 }))).toBe(false)
		expect(isZeroingPlan(summaryWith([], { wouldDelete: 2, wouldConvert: 1 }))).toBe(false)
		expect(isZeroingPlan(summaryWith([]))).toBe(false)
	})
})

describe('formatDeckLine', () => {
	it('renders singular and plural card counts', () => {
		expect(formatDeckLine({ deck: 'Default', cards: 1, new: 1 })).toBe('Default — 1 card (1 new)')
		expect(formatDeckLine({ deck: 'Med', cards: 12, new: 3 })).toBe('Med — 12 cards (3 new)')
		expect(formatDeckLine({ deck: 'Med', cards: 12, new: 0 })).toBe('Med — 12 cards (0 new)')
	})
})
