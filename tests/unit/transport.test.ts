import { describe, it, expect, vi } from 'vitest'
import { AnkiConnectError, AnkiTransport, FetchTransport, setTransport, invoke, parse } from '../../src/anki'

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
})
