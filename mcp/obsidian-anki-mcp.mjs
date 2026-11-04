#!/usr/bin/env node
// MCP (Model Context Protocol) bridge for the Obsidian_to_Anki plugin.
//
// Talks JSON-RPC 2.0 over stdio and forwards each tool call to the plugin's
// local HTTP API (Settings -> Obsidian_to_Anki -> Local API). No dependencies:
// run it with plain `node`, nothing to install (works the same under Nix).
//
//   OBSIDIAN_ANKI_TOKEN  bearer token shown in the plugin settings (required)
//   OBSIDIAN_ANKI_URL    default http://127.0.0.1:27180 (must be loopback)

import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

export const SERVER_INFO = { name: 'obsidian-to-anki', version: '1.0.0' }
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const DEFAULT_URL = 'http://127.0.0.1:27180'
const STATUS_TIMEOUT_MS = 15_000
const SCAN_TIMEOUT_MS = 10 * 60_000
const VALIDATE_TIMEOUT_MS = 2 * 60_000
/** A dry-run on a big vault can list thousands of notes; keep replies readable. */
const MAX_CHANGES = 200

const pathProperty = (description) => ({
	type: 'string',
	description: `${description} Path is relative to the vault root, e.g. "Medicine/Cardiology.md".`
})

export const TOOLS = [
	{
		name: 'anki_status',
		description:
			'Check that the Obsidian plugin API is reachable and whether Anki (AnkiConnect) is ready. Call this first; it changes nothing.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		request: () => ({ method: 'GET', route: '/status', timeoutMs: STATUS_TIMEOUT_MS })
	},
	{
		name: 'anki_dry_run',
		description:
			'Preview what a sync would add, update, delete or convert in Anki. Read-only: writes nothing to Anki or the vault. Run this before anki_scan_vault or anki_scan_file.',
		inputSchema: {
			type: 'object',
			properties: { path: pathProperty('Limit the preview to one file; omit to preview the whole vault.') },
			additionalProperties: false
		},
		request: (args) => ({
			method: 'POST',
			route: '/dry-run',
			body: args.path === undefined ? {} : { path: args.path },
			timeoutMs: SCAN_TIMEOUT_MS
		})
	},
	{
		name: 'anki_validate',
		description:
			'Check flashcard syntax: Cloze without deletions, unknown note types, blocks missing END, IDs reused across blocks or missing from Anki, and labels such as "Extra:" that are not fields of the note type. Read-only. Unlike anki_dry_run it checks files that have not changed, works with Anki closed (IDs are then not checked against Anki), and accepts unsaved text in `content`.',
		inputSchema: {
			type: 'object',
			properties: {
				path: pathProperty(
					'One file to check; omit to check the whole vault. With `content`, it only labels the result.'
				),
				content: { type: 'string', description: 'Markdown to check instead of a saved file (up to 1 MB).' }
			},
			additionalProperties: false
		},
		request: (args) => ({
			method: 'POST',
			route: '/validate',
			body: {
				...(args.path === undefined ? {} : { path: args.path }),
				...(args.content === undefined ? {} : { content: args.content })
			},
			timeoutMs: VALIDATE_TIMEOUT_MS
		})
	},
	{
		name: 'anki_scan_file',
		description:
			'Sync one Markdown file to Anki. WRITES: creates/updates/deletes Anki notes and stamps <!--ID--> comments into the file.',
		inputSchema: {
			type: 'object',
			properties: { path: pathProperty('The file to sync.') },
			required: ['path'],
			additionalProperties: false
		},
		request: (args) => ({
			method: 'POST',
			route: '/scan-file',
			body: { path: args.path },
			timeoutMs: SCAN_TIMEOUT_MS
		})
	},
	{
		name: 'anki_scan_vault',
		description:
			'Sync every changed file in the vault (or the configured Scan Directories) to Anki. WRITES: creates/updates/deletes Anki notes and stamps <!--ID--> comments into files. Only changed files are processed. Prefer anki_dry_run first.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		request: () => ({ method: 'POST', route: '/scan', body: {}, timeoutMs: SCAN_TIMEOUT_MS })
	}
]

/** Only loopback targets: the token must never be sent to another host. */
export function resolveBaseUrl(raw) {
	const url = new URL(raw ?? DEFAULT_URL)
	if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
		throw new Error(`OBSIDIAN_ANKI_URL must be http://127.0.0.1:<port> or http://localhost:<port> (got ${raw}).`)
	}
	return url.origin
}

function textResult(value, isError = false) {
	return {
		content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
		isError
	}
}

/** Trim the potentially huge per-note list of a dry-run reply. */
function trimReport(report) {
	const changes = report?.details?.changes
	if (!Array.isArray(changes) || changes.length <= MAX_CHANGES) {
		return report
	}
	return {
		...report,
		details: {
			...report.details,
			changes: changes.slice(0, MAX_CHANGES),
			changesOmitted: changes.length - MAX_CHANGES
		}
	}
}

function explainHttpFailure(status, body, baseUrl) {
	const detail = body?.error ?? body?.message ?? ''
	if (status === 401) {
		return 'The plugin rejected the token. Copy "Local API Token" from the plugin settings into OBSIDIAN_ANKI_TOKEN.'
	}
	if (status === 409) {
		return 'Another scan is already running in Obsidian. Wait for it to finish and retry.'
	}
	if (status === 503) {
		return `Anki is not ready: ${detail}`
	}
	if (status === 404) {
		return detail || `Not found at ${baseUrl}.`
	}
	return `Plugin API error ${status}: ${detail || 'no details'}`
}

/**
 * Build the message handler. `env` and `fetchImpl` are injectable so tests
 * never touch the network or process state. Returns a function that maps one
 * JSON-RPC message to a response object, or undefined for notifications.
 */
export function createHandler({ env = process.env, fetchImpl = fetch } = {}) {
	async function callTool(name, args) {
		const tool = TOOLS.find((t) => t.name === name)
		if (!tool) {
			return textResult(`Unknown tool: ${name}`, true)
		}
		const token = env.OBSIDIAN_ANKI_TOKEN
		if (!token) {
			return textResult(
				'OBSIDIAN_ANKI_TOKEN is not set. Enable "Local API" in the plugin settings and put its token in this server\'s environment.',
				true
			)
		}
		let baseUrl
		try {
			baseUrl = resolveBaseUrl(env.OBSIDIAN_ANKI_URL)
		} catch (error) {
			return textResult(error.message, true)
		}
		const { method, route, body, timeoutMs } = tool.request(args ?? {})
		let response
		try {
			response = await fetchImpl(`${baseUrl}${route}`, {
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					...(body === undefined ? {} : { 'Content-Type': 'application/json' })
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs)
			})
		} catch (error) {
			const timedOut = error?.name === 'TimeoutError'
			return textResult(
				timedOut
					? `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for Obsidian. The scan may still be running; check anki_status later.`
					: `Cannot reach the plugin API at ${baseUrl}. Is Obsidian running with "Local API" enabled in the plugin settings? (${error?.cause?.code ?? error?.message})`,
				true
			)
		}
		let payload
		try {
			payload = await response.json()
		} catch {
			payload = undefined
		}
		if (!response.ok) {
			// A busy/aborted scan still carries a useful report; show the explanation first.
			return textResult(explainHttpFailure(response.status, payload, baseUrl), true)
		}
		return textResult(trimReport(payload))
	}

	return async function handle(message) {
		if (typeof message !== 'object' || message === null || Array.isArray(message)) {
			return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }
		}
		const { id, method, params } = message
		const isNotification = id === undefined
		const ok = (result) => (isNotification ? undefined : { jsonrpc: '2.0', id, result })
		const fail = (code, text) =>
			isNotification ? undefined : { jsonrpc: '2.0', id, error: { code, message: text } }

		switch (method) {
			case 'initialize': {
				const requested = params?.protocolVersion
				return ok({
					protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
					capabilities: { tools: {} },
					serverInfo: SERVER_INFO
				})
			}
			case 'ping':
				return ok({})
			case 'tools/list':
				return ok({
					tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
				})
			case 'tools/call':
				if (typeof params?.name !== 'string') {
					return fail(-32602, 'tools/call requires a tool name')
				}
				return ok(await callTool(params.name, params.arguments))
			default:
				// notifications/initialized, notifications/cancelled, ... need no reply.
				return method?.startsWith('notifications/') ? undefined : fail(-32601, `Method not found: ${method}`)
		}
	}
}

/** Newline-delimited JSON-RPC over stdin/stdout (MCP stdio transport). */
export function runStdio(handle = createHandler(), input = process.stdin, output = process.stdout) {
	const lines = createInterface({ input })
	const write = (message) => output.write(`${JSON.stringify(message)}\n`)
	lines.on('line', (line) => {
		if (line.trim() === '') {
			return
		}
		void (async () => {
			let message
			try {
				message = JSON.parse(line)
			} catch {
				write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
				return
			}
			const reply = await handle(message)
			if (reply !== undefined) {
				write(reply)
			}
		})()
	})
}

const invokedDirectly =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
if (invokedDirectly) {
	runStdio()
}
