import { describe, it, expect, vi } from 'vitest'
import { App } from 'obsidian'
import { DryRunModal } from '../../src/ui/dry-run-modal'
import type { DryRunSummary } from '../../src/dry-run'

interface MockNode {
	tag?: unknown
	textContent?: unknown
	children?: MockNode[]
	click?: () => void
}

function childrenOf(node: unknown): MockNode[] {
	return (node as { children?: MockNode[] }).children ?? []
}

function allNodes(node: unknown): MockNode[] {
	const self = node as MockNode
	const out: MockNode[] = [self]
	for (const child of childrenOf(node)) {
		out.push(...allNodes(child))
	}
	return out
}

function texts(root: unknown, tag: string): string[] {
	return allNodes(root)
		.filter((n) => n.tag === tag)
		.map((n) => String(n.textContent ?? ''))
}

function buttons(root: unknown): Array<{ text: string; click: () => void }> {
	return allNodes(root)
		.filter((n) => n.tag === 'button' && typeof n.click === 'function')
		.map((n) => ({ text: String(n.textContent ?? ''), click: n.click as () => void }))
}

function mixedSummary(): DryRunSummary {
	return {
		filesChanged: 2,
		filesTotal: 10,
		wouldAdd: 1,
		wouldUpdate: 1,
		wouldDelete: 1,
		wouldConvert: 0,
		decks: [{ deck: 'Default', cards: 3, new: 1 }],
		changes: [
			{ kind: 'add', file: 'b.md', deck: 'Default', modelName: 'Basic' },
			{ kind: 'update', file: 'a.md', noteId: 5, deck: 'Default', modelName: 'Basic', fields: ['Front'] },
			{ kind: 'delete', file: 'gone.md', noteId: 7 }
		]
	}
}

function zeroingSummary(): DryRunSummary {
	return {
		filesChanged: 1,
		filesTotal: 10,
		wouldAdd: 0,
		wouldUpdate: 0,
		wouldDelete: 2,
		wouldConvert: 0,
		decks: [],
		changes: [
			{ kind: 'delete', file: 'a.md', noteId: 1 },
			{ kind: 'delete', file: 'a.md', noteId: 2 }
		]
	}
}

describe('DryRunModal', () => {
	it('renders the summary, per-file groups and both actions', () => {
		const modal = new DryRunModal(new App(), mixedSummary(), { onConfirm: vi.fn(), onCancel: vi.fn() })
		modal.open()

		expect(texts(modal.contentEl, 'h2')).toEqual(['Approve Anki sync'])
		expect(texts(modal.contentEl, 'p')[0]).toContain('would_add=1')
		expect(texts(modal.contentEl, 'li')).toEqual([
			'Default — 3 cards (1 new)',
			'~ #5 Default (Front)',
			'+ Default/Basic',
			'- #7'
		])
		expect(buttons(modal.contentEl).map((b) => b.text)).toEqual(['Cancel', 'Sync now'])
	})

	it('confirms exactly once and never cancels afterwards', () => {
		const onConfirm = vi.fn()
		const onCancel = vi.fn()
		const modal = new DryRunModal(new App(), mixedSummary(), { onConfirm, onCancel })
		modal.open()

		const actions = buttons(modal.contentEl)
		actions[1].click()
		actions[1].click()
		expect(onConfirm).toHaveBeenCalledTimes(1)
		expect(onCancel).not.toHaveBeenCalled()
	})

	it('cancels via the Cancel button', () => {
		const onConfirm = vi.fn()
		const onCancel = vi.fn()
		const modal = new DryRunModal(new App(), mixedSummary(), { onConfirm, onCancel })
		modal.open()

		buttons(modal.contentEl)[0].click()
		expect(onCancel).toHaveBeenCalledTimes(1)
		expect(onConfirm).not.toHaveBeenCalled()
	})

	it('treats dismissal (X/Escape) as cancel, exactly once', () => {
		const onConfirm = vi.fn()
		const onCancel = vi.fn()
		const modal = new DryRunModal(new App(), mixedSummary(), { onConfirm, onCancel })
		modal.open()
		modal.close()
		modal.close()
		expect(onCancel).toHaveBeenCalledTimes(1)
		expect(onConfirm).not.toHaveBeenCalled()
	})

	it('renders the zeroing guard copy for delete-only plans', () => {
		const modal = new DryRunModal(new App(), zeroingSummary(), { onConfirm: vi.fn(), onCancel: vi.fn() })
		modal.open()

		expect(texts(modal.contentEl, 'h2')).toEqual(['Delete every Anki card? (2)'])
		expect(buttons(modal.contentEl).map((b) => b.text)).toEqual(['Cancel', 'Delete all 2 cards'])
		expect(texts(modal.contentEl, 'p').join(' ')).toContain('without adding')
	})
})
