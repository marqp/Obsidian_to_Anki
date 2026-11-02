import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { request } from 'http'
import {
	API_VERSION,
	LocalApiServer,
	MIN_TOKEN_LENGTH,
	generateToken,
	pathForms,
	type ApiHandlers
} from '../../src/api-server'
import type { ScanReport } from '../../src/scan-orchestrator'

const TOKEN = 'test-token-test-token-test-token'

describe('pathForms', () => {
	const nfc = 'Flashcards - Esclerose M\u00faltipla.md'
	const nfd = 'Flashcards - Esclerose Mu\u0301ltipla.md'

	it('tries the given spelling first, then the other Unicode form', () => {
		expect(pathForms(nfd)).toEqual([nfd, nfc])
		expect(pathForms(nfc)).toEqual([nfc, nfd])
	})

	it('does not repeat a path without accents', () => {
		expect(pathForms('notes/a.md')).toEqual(['notes/a.md'])
	})
})

function report(overrides: Partial<ScanReport> = {}): ScanReport {
	return {
		outcome: 'completed',
		dryRun: false,
		filesChanged: 1,
		filesTotal: 3,
		added: 2,
		updated: 0,
		deleted: 0,
		converted: 0,
		issues: [],
		...overrides
	}
}

function makeHandlers(overrides: Partial<ApiHandlers> = {}): ApiHandlers {
	return {
		status: vi.fn(async () => ({ status: 'ready' as const, message: 'ok', version: 6 })),
		scan: vi.fn(async () => report()),
		scanFile: vi.fn(async () => report()),
		dryRun: vi.fn(async () => report({ dryRun: true })),
		...overrides
	}
}

let server: LocalApiServer | undefined

async function start(handlers: ApiHandlers = makeHandlers()): Promise<LocalApiServer> {
	server = new LocalApiServer({ port: 0, token: TOKEN, handlers })
	await server.start()
	return server
}

interface Reply {
	status: number
	body: Record<string, unknown>
}

/** Raw request so tests can control Host and Authorization precisely. */
function call(
	port: number,
	method: string,
	path: string,
	options: { token?: string | null; host?: string; body?: string } = {}
): Promise<Reply> {
	const token = options.token === undefined ? TOKEN : options.token
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: '127.0.0.1',
				port,
				method,
				path,
				headers: {
					Host: options.host ?? `127.0.0.1:${port}`,
					...(token === null ? {} : { Authorization: `Bearer ${token}` }),
					...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {})
				}
			},
			(res) => {
				let data = ''
				res.on('data', (chunk) => (data += chunk))
				res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }))
			}
		)
		req.on('error', reject)
		if (options.body !== undefined) {
			req.write(options.body)
		}
		req.end()
	})
}

beforeEach(() => {
	vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(async () => {
	await server?.stop()
	server = undefined
	vi.restoreAllMocks()
})

describe('LocalApiServer security', () => {
	it('refuses to be built with a short token', () => {
		expect(() => new LocalApiServer({ port: 0, token: 'short', handlers: makeHandlers() })).toThrow(
			`at least ${MIN_TOKEN_LENGTH}`
		)
	})

	it('rejects a missing token with 401', async () => {
		const s = await start()
		const reply = await call(s.port, 'GET', '/status', { token: null })
		expect(reply.status).toBe(401)
	})

	it('rejects a wrong token with 401 and never calls a handler', async () => {
		const handlers = makeHandlers()
		const s = await start(handlers)
		const reply = await call(s.port, 'POST', '/scan', { token: 'x'.repeat(TOKEN.length) })
		expect(reply.status).toBe(401)
		expect(handlers.scan).not.toHaveBeenCalled()
	})

	it('rejects a non-loopback Host header with 403 (DNS rebinding guard)', async () => {
		const s = await start()
		const reply = await call(s.port, 'GET', '/status', { host: 'evil.example.com' })
		expect(reply.status).toBe(403)
	})

	it('accepts localhost as the Host', async () => {
		const s = await start()
		const reply = await call(s.port, 'GET', '/status', { host: `localhost:${s.port}` })
		expect(reply.status).toBe(200)
	})
})

describe('LocalApiServer routes', () => {
	it('GET /status returns the Anki probe and API version', async () => {
		const s = await start()
		const reply = await call(s.port, 'GET', '/status')
		expect(reply.status).toBe(200)
		expect(reply.body).toEqual({
			apiVersion: API_VERSION,
			anki: { status: 'ready', message: 'ok', version: 6 }
		})
	})

	it('POST /scan returns the scan report', async () => {
		const s = await start()
		const reply = await call(s.port, 'POST', '/scan')
		expect(reply.status).toBe(200)
		expect(reply.body).toMatchObject({ outcome: 'completed', added: 2 })
	})

	it('maps busy to 409 and aborted to 503', async () => {
		const handlers = makeHandlers({
			scan: vi
				.fn()
				.mockResolvedValueOnce(report({ outcome: 'busy' }))
				.mockResolvedValueOnce(report({ outcome: 'aborted', message: 'Anki is closed.' }))
		})
		const s = await start(handlers)
		expect((await call(s.port, 'POST', '/scan')).status).toBe(409)
		const aborted = await call(s.port, 'POST', '/scan')
		expect(aborted.status).toBe(503)
		expect(aborted.body['message']).toBe('Anki is closed.')
	})

	it('POST /scan-file passes the path and requires it', async () => {
		const handlers = makeHandlers()
		const s = await start(handlers)
		const ok = await call(s.port, 'POST', '/scan-file', { body: JSON.stringify({ path: 'a/b.md' }) })
		expect(ok.status).toBe(200)
		expect(handlers.scanFile).toHaveBeenCalledWith('a/b.md')
		expect((await call(s.port, 'POST', '/scan-file', { body: '{}' })).status).toBe(400)
		expect((await call(s.port, 'POST', '/scan-file', { body: JSON.stringify({ path: 7 }) })).status).toBe(400)
	})

	it('returns 404 when the file is not in the vault', async () => {
		const s = await start(makeHandlers({ scanFile: vi.fn(async () => null) }))
		const reply = await call(s.port, 'POST', '/scan-file', { body: JSON.stringify({ path: 'nope.md' }) })
		expect(reply.status).toBe(404)
		expect(String(reply.body['error'])).toContain('nope.md')
	})

	it('POST /dry-run works with and without a path', async () => {
		const handlers = makeHandlers()
		const s = await start(handlers)
		expect((await call(s.port, 'POST', '/dry-run')).status).toBe(200)
		expect(handlers.dryRun).toHaveBeenLastCalledWith(undefined)
		await call(s.port, 'POST', '/dry-run', { body: JSON.stringify({ path: 'a.md' }) })
		expect(handlers.dryRun).toHaveBeenLastCalledWith('a.md')
	})

	it('answers 404 for unknown routes and 405 for the wrong method', async () => {
		const s = await start()
		expect((await call(s.port, 'GET', '/nope')).status).toBe(404)
		expect((await call(s.port, 'GET', '/scan')).status).toBe(405)
		expect((await call(s.port, 'POST', '/status')).status).toBe(405)
	})

	it('rejects malformed and oversized bodies', async () => {
		const s = await start()
		expect((await call(s.port, 'POST', '/scan', { body: '{not json' })).status).toBe(400)
		expect((await call(s.port, 'POST', '/scan', { body: '[1]' })).status).toBe(400)
		expect((await call(s.port, 'POST', '/scan', { body: JSON.stringify({ x: 'a'.repeat(20_000) }) })).status).toBe(
			413
		)
	})

	it('turns a handler failure into a 500 with the message', async () => {
		const s = await start(makeHandlers({ scan: vi.fn().mockRejectedValue(new Error('boom')) }))
		const reply = await call(s.port, 'POST', '/scan')
		expect(reply.status).toBe(500)
		expect(reply.body['error']).toBe('boom')
	})
})

describe('LocalApiServer lifecycle', () => {
	it('stops listening after stop() and tolerates a second stop()', async () => {
		const s = await start()
		const port = s.port
		await s.stop()
		await s.stop()
		await expect(call(port, 'GET', '/status')).rejects.toThrow()
	})

	it('fails start() when the port is taken', async () => {
		const first = await start()
		const second = new LocalApiServer({ port: first.port, token: TOKEN, handlers: makeHandlers() })
		await expect(second.start()).rejects.toThrow(/EADDRINUSE/)
	})
})

describe('generateToken', () => {
	it('is long enough for the server and unique', () => {
		const a = generateToken()
		expect(a.length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH)
		expect(generateToken()).not.toBe(a)
	})
})
