import { describe, it, expect, vi, afterEach } from 'vitest'
import { FetchTransport, buildPayload, requiresApiKey, connectionMessage, type PermissionResult } from '../../src/anki'

describe('AnkiConnect auth: apiKey injection', () => {
	it('buildPayload omits key when apiKey is empty', () => {
		expect(buildPayload('modelNames', {})).toEqual({ action: 'modelNames', version: 6, params: {} })
	})

	it('buildPayload includes key when apiKey is set', () => {
		expect(buildPayload('modelNames', {}, 's3cret')).toEqual({
			action: 'modelNames',
			version: 6,
			params: {},
			key: 's3cret'
		})
	})

	it('FetchTransport sends key only when configured', async () => {
		const originalFetch = globalThis.fetch
		const fetchMock = vi.fn().mockResolvedValue({
			json: async () => ({ result: null, error: null })
		})
		globalThis.fetch = fetchMock as unknown as typeof fetch
		try {
			await new FetchTransport(8765).invoke('modelNames')
			expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('key')

			await new FetchTransport(8765, 's3cret').invoke('modelNames')
			expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ key: 's3cret' })
		} finally {
			globalThis.fetch = originalFetch
		}
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})
})

describe('AnkiConnect diagnostics: requestPermission parsing', () => {
	it('requiresApiKey accepts both documented and actual server casings', () => {
		expect(requiresApiKey({ permission: 'granted', requireApiKey: true })).toBe(true)
		expect(requiresApiKey({ permission: 'granted', requireApikey: true })).toBe(true)
		expect(requiresApiKey({ permission: 'granted', requireApiKey: false })).toBe(false)
		expect(requiresApiKey({ permission: 'granted' })).toBe(false)
		expect(requiresApiKey({ permission: 'denied' })).toBe(false)
	})

	it('connectionMessage reports denial', () => {
		const result: PermissionResult = { permission: 'denied' }
		expect(connectionMessage(result, false)).toEqual({
			ok: false,
			message: expect.stringContaining('denied')
		})
	})

	it('connectionMessage asks for the key when required but missing', () => {
		const canonical: PermissionResult = { permission: 'granted', requireApiKey: true, version: 6 }
		const legacy: PermissionResult = { permission: 'granted', requireApikey: true, version: 6 }
		for (const result of [canonical, legacy]) {
			const diagnosis = connectionMessage(result, false)
			expect(diagnosis.ok).toBe(false)
			expect(diagnosis.message).toContain('API key')
		}
	})

	it('connectionMessage confirms granted connections with version', () => {
		const result: PermissionResult = { permission: 'granted', requireApiKey: false, version: 6 }
		expect(connectionMessage(result, false)).toEqual({
			ok: true,
			message: expect.stringContaining('6')
		})
	})
})
