import { App, Modal } from 'obsidian'
import { formatDryRunSummary, type DryRunSummary } from '../dry-run'
import { formatChangeLine, formatDeckLine, formatIssueLine, groupDryRunChanges, isZeroingPlan } from '../dry-run-view'

/** Callbacks the preview owner supplies; exactly one fires per modal session. */
export interface DryRunModalCallbacks {
	onConfirm(): void
	onCancel(): void
}

/**
 * Interactive dry-run preview. Renders only — the summary is collected before
 * opening and the modal never scans. Uses the native Modal/Setting API with
 * `o2a-` classes and theme variables (no Tailwind per AGENTS.md).
 */
export class DryRunModal extends Modal {
	private settled = false

	constructor(
		app: App,
		private readonly summary: DryRunSummary,
		private readonly callbacks: DryRunModalCallbacks
	) {
		super(app)
	}

	onOpen(): void {
		const { contentEl } = this
		const zeroing = isZeroingPlan(this.summary)
		contentEl.createEl('h2', {
			text: zeroing ? `Delete every Anki card? (${this.summary.wouldDelete})` : 'Approve Anki sync'
		})
		contentEl.createEl('p', { text: formatDryRunSummary(this.summary), cls: 'o2a-modal-summary' })
		if (this.summary.resentMedia && this.summary.resentMedia.length > 0) {
			contentEl.createEl('p', {
				text: `Media to send (${this.summary.resentMedia.length}): ${this.summary.resentMedia.join(', ')}`,
				cls: 'o2a-modal-media'
			})
		}
		if (this.summary.decks.length > 0) {
			const decks = contentEl.createEl('ul', { cls: 'o2a-modal-decks' })
			for (const stat of this.summary.decks) {
				decks.createEl('li', { text: formatDeckLine(stat) })
			}
		}
		if (this.summary.wouldDelete > 0) {
			contentEl.createEl('p', {
				text: zeroing
					? 'This plan deletes cards without adding, updating or converting anything. Confirm only if the source blocks are really gone.'
					: 'Deletes remove cards from Anki. Removed blocks can be restored from the note history and re-synced.',
				cls: 'o2a-modal-warning'
			})
		}
		for (const group of groupDryRunChanges(this.summary)) {
			const details = contentEl.createEl('details', { cls: 'o2a-modal-group' })
			details.createEl('summary', {
				text: `${group.displayFile} (${group.entries.length})`
			})
			const list = details.createEl('ul')
			const MAX_ENTRIES_PER_GROUP = 200
			const shown = group.entries.slice(0, MAX_ENTRIES_PER_GROUP)
			for (const entry of shown) {
				list.createEl('li', { text: formatChangeLine(entry) })
			}
			if (group.entries.length > MAX_ENTRIES_PER_GROUP) {
				const remaining = group.entries.length - MAX_ENTRIES_PER_GROUP
				list.createEl('li', { text: `… and ${remaining} more` })
			}
		}
		if (this.summary.issues && this.summary.issues.length > 0) {
			const issuesContainer = contentEl.createEl('div', { cls: 'o2a-modal-issues' })
			issuesContainer.createEl('h3', {
				text: `Issues (${this.summary.issues.length})`,
				cls: 'o2a-issues-heading'
			})
			const issuesList = issuesContainer.createEl('ul', { cls: 'o2a-issues-list' })
			for (const issue of this.summary.issues) {
				issuesList.createEl('li', { text: formatIssueLine(issue) })
			}
		}
		const footer = contentEl.createEl('div', { cls: 'o2a-modal-footer' })
		const cancelButton = footer.createEl('button', { text: 'Cancel' })
		cancelButton.addEventListener('click', () => this.settle(false))
		const confirmButton = footer.createEl('button', {
			text: zeroing ? `Delete all ${this.summary.wouldDelete} cards` : 'Sync now',
			cls: 'mod-cta'
		})
		confirmButton.addEventListener('click', () => this.settle(true))
	}

	onClose(): void {
		// Dismiss via X/Escape counts as cancel; content cleared like Forge's
		// ReportModal pattern so a reopened modal never shows stale entries.
		if (!this.settled) {
			this.settled = true
			this.callbacks.onCancel()
		}
		this.contentEl.empty()
	}

	private settle(confirmed: boolean): void {
		if (this.settled) {
			return
		}
		this.settled = true
		if (confirmed) {
			this.callbacks.onConfirm()
		} else {
			this.callbacks.onCancel()
		}
		this.close()
	}
}
