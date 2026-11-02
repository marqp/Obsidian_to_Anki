import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { clearNotices, createdNotices } from '../mocks/obsidian'
import { createProgressNotice } from '../../src/progress-notice'

interface FakeEl {
	textContent: string
	disabled: boolean
	listeners: Record<string, () => void>
	addEventListener(type: string, fn: () => void): void
}

function fakeEl(): FakeEl {
	const el: FakeEl = {
		textContent: '',
		disabled: false,
		listeners: {},
		addEventListener(type, fn) {
			el.listeners[type] = fn
		}
	}
	return el
}

const created: FakeEl[] = []

beforeEach(() => {
	clearNotices()
	created.length = 0
	vi.stubGlobal('document', {
		createElement: () => {
			const el = fakeEl()
			created.push(el)
			return el
		},
		createDocumentFragment: () => ({ append: vi.fn() })
	})
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('createProgressNotice', () => {
	it('shows nothing for small scans', () => {
		const handle = createProgressNotice()
		handle.control.onProgress?.({ done: 0, total: 5, phase: 'discover' })
		expect(createdNotices).toEqual([])
		handle.close()
	})

	it('shows one notice for large scans and keeps updating its label', () => {
		const handle = createProgressNotice()
		handle.control.onProgress?.({ done: 0, total: 100, phase: 'discover' })
		handle.control.onProgress?.({ done: 40, total: 100, phase: 'scan' })
		expect(createdNotices).toHaveLength(1)
		const label = created[0]
		expect(label.textContent).toBe('Anki sync: parsing 40/100 files')
		handle.close()
	})

	it('cancels via the button', () => {
		const handle = createProgressNotice()
		handle.control.onProgress?.({ done: 0, total: 100, phase: 'discover' })
		expect(handle.control.isCancelled?.()).toBe(false)
		const button = created[1]
		button.listeners['click']()
		expect(handle.control.isCancelled?.()).toBe(true)
		expect(button.disabled).toBe(true)
	})

	it('close is safe when nothing was shown', () => {
		expect(() => createProgressNotice().close()).not.toThrow()
	})
})
