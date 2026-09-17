import { describe, it, expect } from 'vitest'
import { formatChangeLine, groupDryRunChanges, isZeroingPlan, type DryRunGroup } from '../../src/dry-run-view'
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
