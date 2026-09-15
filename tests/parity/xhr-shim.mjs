/**
 * XHR shim for the upstream (pre-transport) AnkiConnect client.
 *
 * The pinned upstream calls `new XMLHttpRequest()` inside src/anki.ts, which
 * does not exist under Node. The generated helpers entry imports this module
 * first so the fake is installed before any AnkiConnect call; `send()`
 * answers `findNotes` with IDs injected via `setParityExistingIds` (called by
 * the entry before `settingToData`). Any other action rejects, keeping the
 * parity run honest: only `findNotes` is ever needed to build FileData.
 */

let parityExistingIds = []

export function setParityExistingIds(ids) {
	parityExistingIds = [...ids]
}

class MockXMLHttpRequest {
	constructor() {
		this.listeners = {}
		this.responseText = ''
		this.requestBody = ''
	}

	addEventListener(type, callback) {
		if (!this.listeners[type]) {
			this.listeners[type] = []
		}
		this.listeners[type].push(callback)
	}

	open(_method, _url) {}

	setRequestHeader(_name, _value) {}

	send(body) {
		this.requestBody = typeof body === 'string' ? body : ''
		queueMicrotask(() => {
			let payload = {}
			try {
				payload = JSON.parse(this.requestBody || '{}')
			} catch {
				this.emit('error')
				return
			}
			if (payload.action === 'findNotes') {
				this.responseText = JSON.stringify({ result: parityExistingIds, error: null })
				this.emit('load')
				return
			}
			this.emit('error')
		})
	}

	emit(type) {
		for (const callback of this.listeners[type] ?? []) {
			callback()
		}
	}
}

if (typeof globalThis.XMLHttpRequest === 'undefined') {
	Object.defineProperty(globalThis, 'XMLHttpRequest', {
		value: MockXMLHttpRequest,
		writable: true,
		configurable: true
	})
}
