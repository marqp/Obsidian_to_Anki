import { describe, it, expect, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { SERVER_INFO, TOOLS, createHandler, resolveBaseUrl, runStdio } from '../../mcp/obsidian-anki-mcp.mjs'

const TOKEN = 'secret-token-secret-token-1'

interface Call {
	url: string
	init: RequestInit & { headers: Record<string, string> }
}

function fakeFetch(status: number, payload: unknown, calls: Call[] = []) {
	return vi.fn(async (url: string, init: Call['init']) => {
		calls.push({ url, init })
		return { ok: status >= 200 && status < 300, status, json: async () => payload }
	}) as unknown as typeof fetch
}

function handlerWith(fetchImpl: typeof fetch, env: Record<string, string> = { OBSIDIAN_ANKI_TOKEN: TOKEN }) {
	return createHandler({ env, fetchImpl })
}

async function callTool(handle: ReturnType<typeof createHandler>, name: string, args: unknown = {}) {
	const reply = (await handle({
		jsonrpc: '2.0',
		id: 1,
		method: 'tools/call',
		params: { name, arguments: args }
	})) as { result: { content: Array<{ text: string }>; isError: boolean } }
	return reply.result
}

describe('protocol', () => {
	const handle = handlerWith(fakeFetch(200, {}))

	it('negotiates a supported protocol version and advertises tools', async () => {
		const reply = (await handle({
			jsonrpc: '2.0',
			id: 0,
			method: 'initialize',
			params: { protocolVersion: '2024-11-05' }
		})) as { result: Record<string, unknown> }
		expect(reply.result).toEqual({
			protocolVersion: '2024-11-05',
			capabilities: { tools: {} },
			serverInfo: SERVER_INFO
		})
	})

	it('falls back to the newest known version for an unknown client version', async () => {
		const reply = (await handle({
			jsonrpc: '2.0',
			id: 0,
			method: 'initialize',
			params: { protocolVersion: '1999-01-01' }
		})) as { result: { protocolVersion: string } }
		expect(reply.result.protocolVersion).toBe('2025-06-18')
	})

	it('answers ping and ignores notifications', async () => {
		expect(await handle({ jsonrpc: '2.0', id: 2, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 2, result: {} })
		expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined()
	})

	it('lists every tool without leaking the request builders', async () => {
		const reply = (await handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })) as {
			result: { tools: Array<Record<string, unknown>> }
		}
		expect(reply.result.tools.map((t) => t['name'])).toEqual(TOOLS.map((t: { name: string }) => t.name))
		expect(reply.result.tools.every((t) => !('request' in t) && 'inputSchema' in t)).toBe(true)
	})

	it('rejects unknown methods and malformed messages', async () => {
		expect(await handle({ jsonrpc: '2.0', id: 4, method: 'nope' })).toMatchObject({ error: { code: -32601 } })
		expect(await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: {} })).toMatchObject({
			error: { code: -32602 }
		})
		expect(await handle([] as never)).toMatchObject({ error: { code: -32600 } })
	})
})

describe('tool calls', () => {
	it('anki_status sends an authorised GET', async () => {
		const calls: Call[] = []
		const result = await callTool(handlerWith(fakeFetch(200, { apiVersion: 1 }, calls)), 'anki_status')
		expect(calls[0].url).toBe('http://127.0.0.1:27180/status')
		expect(calls[0].init.method).toBe('GET')
		expect(calls[0].init.headers['Authorization']).toBe(`Bearer ${TOKEN}`)
		expect(result.isError).toBe(false)
		expect(JSON.parse(result.content[0].text)).toEqual({ apiVersion: 1 })
	})

	it('anki_scan_file forwards the path as JSON', async () => {
		const calls: Call[] = []
		await callTool(handlerWith(fakeFetch(200, { outcome: 'completed' }, calls)), 'anki_scan_file', {
			path: 'a/b.md'
		})
		expect(calls[0].url).toBe('http://127.0.0.1:27180/scan-file')
		expect(JSON.parse(calls[0].init.body as string)).toEqual({ path: 'a/b.md' })
		expect(calls[0].init.headers['Content-Type']).toBe('application/json')
	})

	it('anki_dry_run omits the path for a whole-vault preview', async () => {
		const calls: Call[] = []
		const handle = handlerWith(fakeFetch(200, {}, calls))
		await callTool(handle, 'anki_dry_run')
		await callTool(handle, 'anki_dry_run', { path: 'x.md' })
		expect(JSON.parse(calls[0].init.body as string)).toEqual({})
		expect(JSON.parse(calls[1].init.body as string)).toEqual({ path: 'x.md' })
	})

	it('anki_scan_vault posts to /scan and honours a custom URL', async () => {
		const calls: Call[] = []
		const env = { OBSIDIAN_ANKI_TOKEN: TOKEN, OBSIDIAN_ANKI_URL: 'http://localhost:9999' }
		await callTool(handlerWith(fakeFetch(200, {}, calls), env), 'anki_scan_vault')
		expect(calls[0].url).toBe('http://localhost:9999/scan')
	})

	it('trims a huge dry-run change list and says how much was omitted', async () => {
		const changes = Array.from({ length: 250 }, (_, i) => ({ id: i }))
		const result = await callTool(handlerWith(fakeFetch(200, { details: { decks: [], changes } })), 'anki_dry_run')
		const body = JSON.parse(result.content[0].text)
		expect(body.details.changes).toHaveLength(200)
		expect(body.details.changesOmitted).toBe(50)
	})

	it('reports an unknown tool as a tool error', async () => {
		const result = await callTool(handlerWith(fakeFetch(200, {})), 'nope')
		expect(result.isError).toBe(true)
	})
})

describe('failure handling', () => {
	it('requires the token and never calls the network without it', async () => {
		const fetchImpl = fakeFetch(200, {})
		const result = await callTool(handlerWith(fetchImpl, {}), 'anki_status')
		expect(result.isError).toBe(true)
		expect(result.content[0].text).toContain('OBSIDIAN_ANKI_TOKEN')
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('refuses a non-loopback URL so the token cannot leak', async () => {
		const fetchImpl = fakeFetch(200, {})
		const env = { OBSIDIAN_ANKI_TOKEN: TOKEN, OBSIDIAN_ANKI_URL: 'http://evil.example.com:27180' }
		const result = await callTool(handlerWith(fetchImpl, env), 'anki_status')
		expect(result.isError).toBe(true)
		expect(fetchImpl).not.toHaveBeenCalled()
		expect(() => resolveBaseUrl('https://127.0.0.1:1')).toThrow()
	})

	it.each([
		[401, {}, 'rejected the token'],
		[409, {}, 'already running'],
		[503, { message: 'Anki is closed.' }, 'Anki is not ready'],
		[404, { error: 'Not a file in this vault: x.md' }, 'x.md'],
		[500, { error: 'boom' }, 'boom']
	])('explains HTTP %i', async (status, payload, expected) => {
		const result = await callTool(handlerWith(fakeFetch(status, payload)), 'anki_scan_vault')
		expect(result.isError).toBe(true)
		expect(result.content[0].text).toContain(expected)
	})

	it('explains an unreachable plugin', async () => {
		const fetchImpl = vi
			.fn()
			.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))
		const result = await callTool(handlerWith(fetchImpl as never), 'anki_status')
		expect(result.isError).toBe(true)
		expect(result.content[0].text).toContain('Local API')
		expect(result.content[0].text).toContain('ECONNREFUSED')
	})

	it('explains a timeout', async () => {
		const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
		const result = await callTool(handlerWith(vi.fn().mockRejectedValue(timeout) as never), 'anki_status')
		expect(result.content[0].text).toContain('Timed out')
	})

	it('survives a non-JSON error body', async () => {
		const fetchImpl = vi.fn(async () => ({
			ok: false,
			status: 502,
			json: async () => {
				throw new Error('not json')
			}
		}))
		const result = await callTool(handlerWith(fetchImpl as never), 'anki_status')
		expect(result.content[0].text).toContain('502')
	})
})

describe('stdio transport', () => {
	it('answers newline-delimited requests, skips notifications and reports parse errors', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		runStdio(handlerWith(fakeFetch(200, {})), input, output)
		const received = new Promise<string[]>((resolve) => {
			let data = ''
			output.on('data', (chunk) => {
				data += chunk
				const lines = data.split('\n').filter(Boolean)
				if (lines.length === 2) {
					resolve(lines)
				}
			})
		})
		input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
		input.write('{"jsonrpc":"2.0","id":7,"method":"ping"}\n')
		input.write('this is not json\n')
		const lines = await received
		const replies = lines.map((l) => JSON.parse(l))
		expect(replies).toContainEqual({ jsonrpc: '2.0', id: 7, result: {} })
		expect(replies).toContainEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
		input.end()
	})
})
