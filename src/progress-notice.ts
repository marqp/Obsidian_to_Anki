import { Notice } from 'obsidian'
import type { ScanControl } from './files-manager'

/** Progress UI for a scan plus the ScanControl that feeds and cancels it. */
export interface ScanProgressHandle {
	control: ScanControl
	/** Remove the UI; safe to call when nothing was ever shown. */
	close(): void
}

/** Below this many candidate files a scan finishes before a notice is worth showing. */
const MIN_FILES_FOR_NOTICE = 25

/**
 * Persistent Notice with a Cancel button. Created lazily on the first
 * progress event that is large enough, so small scans never flash a notice.
 */
export function createProgressNotice(): ScanProgressHandle {
	let notice: Notice | undefined
	let label: HTMLElement | undefined
	let cancelled = false

	const show = (): HTMLElement => {
		const text = document.createElement('span')
		const button = document.createElement('button')
		button.textContent = 'Cancel'
		button.addEventListener('click', () => {
			cancelled = true
			button.disabled = true
			button.textContent = 'Cancelling...'
		})
		const fragment = document.createDocumentFragment()
		fragment.append(text, ' ', button)
		notice = new Notice(fragment, 0)
		label = text
		return text
	}

	return {
		control: {
			isCancelled: () => cancelled,
			onProgress: ({ done, total, phase }) => {
				if (total < MIN_FILES_FOR_NOTICE) {
					return
				}
				const text = label ?? show()
				text.textContent = `Anki sync: ${phase === 'scan' ? 'parsing' : 'reading'} ${done}/${total} files`
			}
		},
		close: () => {
			notice?.hide()
			notice = undefined
			label = undefined
		}
	}
}
