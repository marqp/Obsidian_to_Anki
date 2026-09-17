import { describe, it, expect, vi, afterEach } from 'vitest'
import {
	AnkiConnectError,
	AnkiTransport,
	FetchTransport,
	ObsidianRequestUrlTransport,
	assertResponseShape,
	setTransport,
	invoke,
	parse,
	withRequestTimeout
} from '../../src/anki'
import { requestedUrls, clearRequestedUrls } from '../mocks/obsidian'

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

describe('Transport: AnkiTransport & AnkiConnectError', () => {
	it('throws AnkiConnectError with action and message when Anki returns error', async () => {
		const mockTransport: AnkiTransport = {
			async invoke(action: string, _params?: Record<string, unknown>) {
				throw new AnkiConnectError(action, 'model does not exist')
			}
		}
		setTransport(mockTransport)

		await expect(invoke('modelFieldNames', { modelName: 'Fake' })).rejects.toThrow(
			'AnkiConnect [modelFieldNames]: model does not exist'
		)
		await expect(invoke('modelFieldNames', { modelName: 'Fake' })).rejects.toBeInstanceOf(AnkiConnectError)
	})

	it('parse throws AnkiConnectError when response has error string', () => {
		expect(() => parse({ error: 'something broke', result: null })).toThrow('AnkiConnect [parse]: something broke')
		expect(() => parse({ error: 'something broke', result: null })).toThrow(AnkiConnectError)
	})

	it('parse returns result directly when error is null', () => {
		const res = parse({ error: null, result: [1, 2, 3] })
		expect(res).toEqual([1, 2, 3])
	})

	it('FetchTransport sends POST request with correct payload', async () => {
		const originalFetch = globalThis.fetch
		const fetchMock = vi.fn().mockResolvedValue({
			json: async () => ({ result: ['Basic', 'Cloze'], error: null })
		})
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const transport = new FetchTransport(8765)
		const result = await transport.invoke('modelNames')

		expect(result).toEqual(['Basic', 'Cloze'])
		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:8765',
			expect.objectContaining({
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'modelNames', version: 6, params: {} })
			})
		)

		globalThis.fetch = originalFetch
	})

	it('FetchTransport throws AnkiConnectError when Anki returns error', async () => {
		const originalFetch = globalThis.fetch
		globalThis.fetch = vi.fn().mockResolvedValue({
			json: async () => ({ result: null, error: 'collection is open' })
		}) as unknown as typeof fetch

		const transport = new FetchTransport(8765)
		await expect(transport.invoke('sync')).rejects.toThrow('AnkiConnect [sync]: collection is open')
		await expect(transport.invoke('sync')).rejects.toBeInstanceOf(AnkiConnectError)

		globalThis.fetch = originalFetch
	})

	it('ObsidianRequestUrlTransport omits the key by default, sends it when set', async () => {
		clearRequestedUrls()
		await new ObsidianRequestUrlTransport().invoke('modelNames')
		const request = requestedUrls[0] as {
			url: string
			method: string
			headers: Record<string, string>
			body: string
		}
		expect(request.url).toBe('http://127.0.0.1:8765')
		expect(request.method).toBe('POST')
		expect(request.headers).toEqual({ 'Content-Type': 'application/json' })
		const anonymous = JSON.parse(request.body)
		expect(anonymous).not.toHaveProperty('key')

		clearRequestedUrls()
		await new ObsidianRequestUrlTransport(8765, 's3cret').invoke('modelNames')
		const keyed = JSON.parse((requestedUrls[0] as { body: string }).body)
		expect(keyed).toMatchObject({ key: 's3cret' })
	})
})

describe('Transport hardening: timeout + response shape', () => {
	it('withRequestTimeout passes fast responses through untouched', async () => {
		await expect(withRequestTimeout(Promise.resolve(5), 'sync', 1000)).resolves.toBe(5)
	})

	it('withRequestTimeout rejects a hung request with the action name', async () => {
		vi.useFakeTimers()
		try {
			const pending = withRequestTimeout(new Promise<string>(() => undefined), 'sync', 1000)
			const assertion = expect(pending).rejects.toThrow('AnkiConnect request timed out after 1000ms: sync')
			await vi.advanceTimersByTimeAsync(1000)
			await assertion
		} finally {
			vi.useRealTimers()
		}
	})

	it('assertResponseShape rejects non-object bodies, stays lenient on {}', () => {
		for (const bad of ['proxy html', null, undefined, 42, ['result']]) {
			expect(() => assertResponseShape('sync', bad)).toThrow(
				'AnkiConnect [sync]: malformed response from AnkiConnect'
			)
		}
		expect(assertResponseShape('sync', {})).toBeUndefined()
		expect(assertResponseShape('sync', { error: null, result: [] })).toBeUndefined()
	})

	it('FetchTransport surfaces malformed bodies as AnkiConnectError', async () => {
		const originalFetch = globalThis.fetch
		globalThis.fetch = vi.fn().mockResolvedValue({
			json: async () => '<html>proxy login</html>'
		}) as unknown as typeof fetch

		await expect(new FetchTransport(8765).invoke('sync')).rejects.toThrow(
			'AnkiConnect [sync]: malformed response from AnkiConnect'
		)

		globalThis.fetch = originalFetch
	})

	it('FetchTransport wraps a hung daemon in a timeout failure', async () => {
		const originalFetch = globalThis.fetch
		globalThis.fetch = vi.fn().mockImplementation(
			() =>
				new Promise(() => {
					// Never resolves: the timeout must win.
				})
		) as unknown as typeof fetch
		vi.useFakeTimers()
		try {
			const pending = new FetchTransport(8765).invoke('sync')
			const assertion = expect(pending).rejects.toThrow(
				'Failed to connect to Anki: AnkiConnect request timed out'
			)
			await vi.advanceTimersByTimeAsync(30000)
			await assertion
		} finally {
			vi.useRealTimers()
			globalThis.fetch = originalFetch
		}
	})
})
