import type { DryRunChange, DryRunDeckStat, DryRunSummary } from './dry-run'

/**
 * Pure view-model for the dry-run preview modal (no Obsidian imports, so it
 * is fully unit-testable). Groups the flat `changes[]` list per file and
 * formats one human line per change. The modal itself lives in
 * `src/ui/dry-run-modal.ts` and only renders these structures.
 */
export interface DryRunGroup {
	/** Original file path from the change (`''` for unattributed orphans). */
	file: string
	/** Display heading: the path, or '(unknown file)' when empty. */
	displayFile: string
	entries: DryRunChange[]
}

const KIND_ORDER: Record<DryRunChange['kind'], number> = {
	delete: 0,
	convert: 1,
	update: 2,
	add: 3
}

/** Group changes per file, deletes first inside each group. */
export function groupDryRunChanges(summary: DryRunSummary): DryRunGroup[] {
	const byFile = new Map<string, DryRunChange[]>()
	for (const change of summary.changes) {
		const list = byFile.get(change.file) ?? []
		list.push(change)
		byFile.set(change.file, list)
	}
	const groups: DryRunGroup[] = []
	for (const [file, entries] of byFile) {
		entries.sort((a, b) => {
			const order = KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
			if (order !== 0) {
				return order
			}
			return (a.noteId ?? 0) - (b.noteId ?? 0)
		})
		groups.push({ file, displayFile: file === '' ? '(unknown file)' : file, entries })
	}
	groups.sort((a, b) => (a.displayFile < b.displayFile ? -1 : a.displayFile > b.displayFile ? 1 : 0))
	return groups
}

/** One human-readable line per change (mirrors the console semantics). */
export function formatChangeLine(change: DryRunChange): string {
	switch (change.kind) {
		case 'add':
			return `+ ${change.deck ?? ''}/${change.modelName ?? ''}`
		case 'update':
			return `~ #${change.noteId ?? '?'} ${change.deck ?? ''} (${(change.fields ?? []).join(', ')})`
		case 'delete':
			return `- #${change.noteId ?? '?'}`
		case 'convert':
			return `⇄ #${change.noteId ?? '?'} ${change.fromModel ?? ''}→${change.toModel ?? ''}`
	}
}

/**
 * Zeroing-guard: the plan deletes without creating, updating or converting
 * anything. The modal renders a distinct destructive title and CTA for this
 * case (Forge `isZeroingPlan` pattern) instead of the normal approve copy.
 */
export function isZeroingPlan(summary: DryRunSummary): boolean {
	return summary.wouldDelete > 0 && summary.wouldAdd === 0 && summary.wouldUpdate === 0 && summary.wouldConvert === 0
}

/** One ambient line per touched deck: `Default — 12 cards (3 new)`. */
export function formatDeckLine(stat: DryRunDeckStat): string {
	const cards = stat.cards === 1 ? '1 card' : `${stat.cards} cards`
	const fresh = stat.new === 1 ? '1 new' : `${stat.new} new`
	return `${stat.deck} — ${cards} (${fresh})`
}
