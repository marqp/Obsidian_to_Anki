import { describe, it, expect, afterEach, vi } from 'vitest'
import { spawn } from 'child_process'
import path from 'path'
import { LocalApiServer, generateToken, type ApiHandlers } from '../../src/api-server'
import type { ScanReport } from '../../src/scan-orchestrator'

const SCRIPT = path.resolve(__dirname, '../../mcp/obsidian-anki-mcp.mjs')

function report(overrides: Partial<ScanReport> = {}): ScanReport {
	return {
		outcome: 'completed',
		dryRun: false,
		filesChanged: 1,
		filesTotal: 1,
		added: 3,
		updated: 0,
		deleted: 0,
		converted: 0,
		issues: [],
		...overrides
	}
}

let server: LocalApiServer | undefined

afterEach(async () => {
	await server?.stop()
	server = undefined
})

/** Spawn the real MCP script, send requests, collect `count` replies. */
function talkToMcp(env: Record<string, string>, requests: unknown[], count: number): Promise<unknown[]> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [SCRIPT], { env: { PATH: process.env['PATH'] ?? '', ...env } })
		const replies: unknown[] = []
		let buffer = ''
		const timer = setTimeout(() => {
			child.kill()
			reject(new Error(`timed out; got ${JSON.stringify(replies)}`))
		}, 10_000)
		child.stdout.on('data', (chunk) => {
			buffer += chunk
			const lines = buffer.split('\n')
			buffer = lines.pop() ?? ''
			for (const line of lines.filter(Boolean)) {
				replies.push(JSON.parse(line))
			}
			if (replies.length >= count) {
				clearTimeout(timer)
				child.kill()
				resolve(replies)
			}
		})
		child.on('error', reject)
		for (const request of requests) {
			child.stdin.write(`${JSON.stringify(request)}\n`)
		}
	})
}

describe('MCP bridge against the real local API', () => {
	it('runs initialize -> tools/call -> plugin handler -> structured report', async () => {
		const handlers: ApiHandlers = {
			status: vi.fn(async () => ({ status: 'ready' as const, message: 'ok', version: 6 })),
			scan: vi.fn(async () => report()),
			scanFile: vi.fn(async () => report({ added: 1 })),
			scanFolder: vi.fn(async () => report()),
			scanFiles: vi.fn(async () => report()),
			dryRun: vi.fn(async () => report({ dryRun: true })),
			validate: vi.fn(async () => null),
			scanState: () => ({ inProgress: false }),
			metadata: vi.fn(),
			searchNotes: vi.fn(),
			getNotes: vi.fn(),
			studyOverview: vi.fn(),
			difficultCards: vi.fn()
		}
		const token = generateToken()
		server = new LocalApiServer({ port: 0, token, handlers })
		await server.start()
		const env = { OBSIDIAN_ANKI_TOKEN: token, OBSIDIAN_ANKI_URL: `http://127.0.0.1:${server.port}` }

		const replies = (await talkToMcp(
			env,
			[
				{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
				{ jsonrpc: '2.0', method: 'notifications/initialized' },
				{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'anki_status', arguments: {} } },
				{
					jsonrpc: '2.0',
					id: 3,
					method: 'tools/call',
					params: { name: 'anki_scan_file', arguments: { path: 'Notes/a.md' } }
				}
			],
			3
		)) as Array<{
			id: number
			result: { content?: Array<{ text: string }>; isError?: boolean; serverInfo?: unknown }
		}>

		const byId = new Map(replies.map((r) => [r.id, r.result]))
		expect(byId.get(1)?.serverInfo).toMatchObject({ name: 'obsidian-to-anki' })
		expect(JSON.parse(byId.get(2)?.content?.[0].text ?? '{}')).toMatchObject({ anki: { status: 'ready' } })
		expect(byId.get(3)?.isError).toBe(false)
		expect(JSON.parse(byId.get(3)?.content?.[0].text ?? '{}')).toMatchObject({ outcome: 'completed', added: 1 })
		expect(handlers.scanFile).toHaveBeenCalledWith('Notes/a.md')
	})

	it('surfaces a wrong token as a tool error, not a crash', async () => {
		server = new LocalApiServer({
			port: 0,
			token: generateToken(),
			handlers: {
				status: vi.fn(),
				scan: vi.fn(),
				scanFile: vi.fn(),
				dryRun: vi.fn(),
				validate: vi.fn(),
				scanState: vi.fn(),
				metadata: vi.fn(),
				searchNotes: vi.fn(),
				getNotes: vi.fn(),
				studyOverview: vi.fn(),
				difficultCards: vi.fn()
			}
		})
		await server.start()
		const env = { OBSIDIAN_ANKI_TOKEN: 'x'.repeat(30), OBSIDIAN_ANKI_URL: `http://127.0.0.1:${server.port}` }
		const replies = (await talkToMcp(
			env,
			[{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'anki_status', arguments: {} } }],
			1
		)) as Array<{ result: { isError: boolean; content: Array<{ text: string }> } }>
		expect(replies[0].result.isError).toBe(true)
		expect(replies[0].result.content[0].text).toContain('rejected the token')
	})
})
