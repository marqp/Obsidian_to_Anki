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

export const SERVER_INFO = { name: 'obsidian-to-anki', version: '2.0.0' }
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const DEFAULT_URL = 'http://127.0.0.1:27180'
const STATUS_TIMEOUT_MS = 15_000
const SCAN_TIMEOUT_MS = 10 * 60_000
const VALIDATE_TIMEOUT_MS = 2 * 60_000
const READ_TIMEOUT_MS = 60_000
const MAX_PAGE = 100
/** The plugin API this bridge was written for. */
export const EXPECTED_API_VERSION = 3
/** A dry-run on a big vault can list thousands of notes; keep replies readable. */
const MAX_CHANGES = 200
/** Validating a whole vault can flag thousands of lines; counts say the rest. */
const MAX_ISSUES = 200
/** The riskiest changes survive the cut. */
const CHANGE_PRIORITY = { delete: 0, convert: 1, update: 2, add: 3 }
/** First protocol version with structured tool output. */
const STRUCTURED_OUTPUT_PROTOCOL = '2025-06-18'

export const INSTRUCTIONS = `Flashcards live in Markdown files in an Obsidian vault and are synced one way to Anki: Markdown is the source of truth, so change a card by editing its file, never in Anki. A sync overwrites the note's fields and tags from the file.

Card format:
START
Basic
Front: question
Back: answer
END

START
Cloze
Text with ==masked term==, or {{c1::masked term}}
Extra: optional context
END

The first line is the note type; call anki_get_metadata for the types and their fields, tags, decks and syntax settings. A label that is not a field of the type stays as literal text, so a Basic card must not use "Extra:". A Cloze card with no deletion is not sent. TARGET DECK and FILE TAGS lines at the top of a file set its deck and tags.

The plugin stamps <!--ID: 123--> before END. Never write or copy one: two blocks with one ID overwrite the same note, and removing the line creates a new card without its review history. To delete a card, replace its block with DELETE and its ID on the next line, or remove the block.

Workflow: anki_search_notes to avoid duplicates, write the file, anki_validate, anki_dry_run, show the result to the user, then anki_scan_file. Report every entry in "issues": it means something did not reach Anki as written.`

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const WRITES_VAULT = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }

const issueListSchema = { type: 'array', items: { type: 'object' } }
const scanReportSchema = {
	type: 'object',
	properties: {
		outcome: { type: 'string' },
		dryRun: { type: 'boolean' },
		filesChanged: { type: 'number' },
		filesTotal: { type: 'number' },
		added: { type: 'number' },
		updated: { type: 'number' },
		deleted: { type: 'number' },
		converted: { type: 'number' },
		issues: issueListSchema,
		issuesOmitted: { type: 'number' },
		issuesByKind: { type: 'object' },
		details: { type: 'object' }
	},
	required: ['outcome', 'issues']
}
const notePageSchema = {
	type: 'object',
	properties: {
		total: { type: 'number' },
		offset: { type: 'number' },
		limit: { type: 'number' },
		notes: { type: 'array', items: { type: 'object' } }
	},
	required: ['total', 'notes']
}

const rawProperty = { type: 'boolean', description: 'Return field HTML instead of plain text.' }
const deckProperty = { type: 'string', description: 'Limit to this deck and its subdecks; omit for all decks.' }

const pathProperty = (description) => ({
	type: 'string',
	description: `${description} Path is relative to the vault root, e.g. "Medicine/Cardiology.md".`
})

export const TOOLS = [
	{
		name: 'anki_status',
		title: 'Check plugin and Anki',
		description:
			'Check that the Obsidian plugin API is reachable, whether Anki (AnkiConnect) is ready, whether a scan is running, and how the last scan ended. Call this first; it changes nothing.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: READ_ONLY,
		outputSchema: {
			type: 'object',
			properties: {
				apiVersion: { type: 'number' },
				anki: { type: 'object' },
				scan: { type: 'object' },
				warning: { type: 'string' }
			},
			required: ['anki']
		},
		request: () => ({ method: 'GET', route: '/status', timeoutMs: STATUS_TIMEOUT_MS })
	},
	{
		name: 'anki_dry_run',
		title: 'Preview a sync',
		annotations: READ_ONLY,
		outputSchema: scanReportSchema,
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
		title: 'Check flashcard syntax',
		annotations: READ_ONLY,
		outputSchema: {
			type: 'object',
			properties: {
				filesChecked: { type: 'number' },
				blocks: { type: 'number' },
				errors: { type: 'number' },
				warnings: { type: 'number' },
				ankiChecked: { type: 'boolean' },
				byKind: { type: 'object' },
				issues: issueListSchema,
				issuesOmitted: { type: 'number' }
			},
			required: ['errors', 'warnings', 'issues']
		},
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
		title: 'Sync one file to Anki',
		annotations: WRITES_VAULT,
		outputSchema: scanReportSchema,
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
		title: 'Sync the vault to Anki',
		annotations: WRITES_VAULT,
		outputSchema: scanReportSchema,
		description:
			'Sync every changed file in the vault (or the configured Scan Directories) to Anki. WRITES: creates/updates/deletes Anki notes and stamps <!--ID--> comments into files. Only changed files are processed. Prefer anki_dry_run first.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		request: () => ({ method: 'POST', route: '/scan', body: {}, timeoutMs: SCAN_TIMEOUT_MS })
	},
	{
		name: 'anki_get_metadata',
		title: 'List decks, note types and tags',
		description:
			'List the Anki decks, note types with their fields, and tags, plus the plugin settings that decide how cards are written (for example whether ==highlights== become clozes). Read this before writing cards for a new topic, and reuse existing tags instead of inventing near-duplicates.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: READ_ONLY,
		outputSchema: {
			type: 'object',
			properties: {
				decks: { type: 'array', items: { type: 'string' } },
				noteTypes: { type: 'array', items: { type: 'object' } },
				tags: { type: 'array', items: { type: 'string' } },
				rules: { type: 'object' }
			},
			required: ['decks', 'noteTypes', 'tags', 'rules']
		},
		request: () => ({ method: 'GET', route: '/metadata', timeoutMs: READ_TIMEOUT_MS })
	},
	{
		name: 'anki_search_notes',
		title: 'Search notes in Anki',
		description:
			'Search the whole Anki collection, including notes that exist only in Anki, and return their text, tags, cards and `sourceFile` (the vault file holding them, absent if none). Use it to find existing cards before writing new ones. Read-only.',
		inputSchema: {
			type: 'object',
			properties: {
				query: {
					type: 'string',
					description:
						'Anki search syntax. Examples: `deck:Medicina "dor torácica"`, `tag:Cardiologia`, `note:Cloze front:*sepse*`, `is:suspended`. Words are ANDed.'
				},
				limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE, description: 'Page size (default 20).' },
				offset: { type: 'integer', minimum: 0, description: 'Notes to skip, for the next page.' },
				raw: rawProperty
			},
			required: ['query'],
			additionalProperties: false
		},
		annotations: READ_ONLY,
		outputSchema: notePageSchema,
		request: (args) => ({ method: 'POST', route: '/notes/search', body: args, timeoutMs: READ_TIMEOUT_MS })
	},
	{
		name: 'anki_get_notes',
		title: 'Read notes by ID',
		description:
			'Read specific Anki notes by note ID: text, tags, cards with their scheduling state, and `sourceFile`. IDs Anki does not know are listed in `missing`. Read-only.',
		inputSchema: {
			type: 'object',
			properties: {
				ids: {
					type: 'array',
					items: { type: 'integer' },
					minItems: 1,
					maxItems: MAX_PAGE,
					description: 'Note IDs.'
				},
				raw: rawProperty
			},
			required: ['ids'],
			additionalProperties: false
		},
		annotations: READ_ONLY,
		outputSchema: {
			type: 'object',
			properties: {
				notes: { type: 'array', items: { type: 'object' } },
				missing: { type: 'array', items: { type: 'number' } }
			},
			required: ['notes', 'missing']
		},
		request: (args) => ({ method: 'POST', route: '/notes/get', body: args, timeoutMs: READ_TIMEOUT_MS })
	},
	{
		name: 'anki_study_overview',
		title: 'Study overview',
		description:
			'Summarise study state: cards due, suspended and leeches, cards reviewed today and per day, and new, learning and review counts per deck. Read-only.',
		inputSchema: {
			type: 'object',
			properties: {
				deck: deckProperty,
				days: { type: 'integer', minimum: 1, maximum: 365, description: 'Days of review history (default 30).' }
			},
			additionalProperties: false
		},
		annotations: READ_ONLY,
		outputSchema: {
			type: 'object',
			properties: {
				due: { type: 'number' },
				suspended: { type: 'number' },
				leeches: { type: 'number' },
				reviewedToday: { type: 'number' },
				reviewsByDay: { type: 'array', items: { type: 'object' } },
				decks: { type: 'array', items: { type: 'object' } }
			},
			required: ['due', 'suspended', 'leeches', 'reviewedToday']
		},
		request: (args) => ({ method: 'POST', route: '/study/overview', body: args, timeoutMs: READ_TIMEOUT_MS })
	},
	{
		name: 'anki_difficult_cards',
		title: 'Cards failed most often',
		description:
			'List the cards the user fails most, most lapses first, with their text, review counts and `sourceFile`. Use it to rewrite weak cards: edit the block in `sourceFile`, keeping its ID line. Cards without `sourceFile` exist only in Anki. Read-only.',
		inputSchema: {
			type: 'object',
			properties: {
				deck: deckProperty,
				minLapses: { type: 'integer', minimum: 1, description: 'Least lapses to qualify (default 4).' },
				limit: {
					type: 'integer',
					minimum: 1,
					maximum: MAX_PAGE,
					description: 'Most cards to return (default 20).'
				},
				includeSuspended: { type: 'boolean', description: 'Also list suspended cards (default false).' },
				raw: rawProperty
			},
			additionalProperties: false
		},
		annotations: READ_ONLY,
		outputSchema: {
			type: 'object',
			properties: { total: { type: 'number' }, cards: { type: 'array', items: { type: 'object' } } },
			required: ['total', 'cards']
		},
		request: (args) => ({ method: 'POST', route: '/study/difficult', body: args, timeoutMs: READ_TIMEOUT_MS })
	},
	{
		name: 'anki_import_preview',
		title: 'Preview importing Anki-only notes',
		description:
			'Plans bringing the notes that exist only in Anki into the vault, without writing anything. Each note is converted to Markdown and rendered back by the real parser; a note that would change stays in Anki and is listed in `refused` with the reason. Image Occlusion and overlapping Cloze notes are never candidates.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: READ_ONLY,
		outputSchema: {
			type: 'object',
			properties: {
				candidates: { type: 'number' },
				ready: { type: 'number' },
				refused: { type: 'array', items: { type: 'object' } },
				files: { type: 'array', items: { type: 'object' } },
				structuralErrors: { type: 'number' }
			},
			required: ['candidates', 'ready', 'refused', 'files', 'structuralErrors']
		},
		request: () => ({ method: 'POST', route: '/import/preview', body: {}, timeoutMs: SCAN_TIMEOUT_MS })
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
		content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
		isError
	}
}

/** A successful reply: the JSON as text, plus structured for clients that read it. */
function dataResult(value) {
	return { ...textResult(value), structuredContent: value }
}

function countByKind(items) {
	const counts = {}
	for (const item of items) {
		counts[item.kind] = (counts[item.kind] ?? 0) + 1
	}
	return counts
}

/** Trim the potentially huge per-note lists, saying what was left out. */
function trimReport(report) {
	let trimmed = report
	const issues = report?.issues
	if (Array.isArray(issues) && issues.length > MAX_ISSUES) {
		// Errors first: thousands of warnings must not push them out of the cut.
		const ranked = [...issues].sort((a, b) => Number(a.severity === 'warning') - Number(b.severity === 'warning'))
		trimmed = {
			...trimmed,
			issues: ranked.slice(0, MAX_ISSUES),
			issuesOmitted: issues.length - MAX_ISSUES,
			issuesByKind: countByKind(issues)
		}
	}
	const changes = report?.details?.changes
	if (Array.isArray(changes) && changes.length > 0) {
		const ranked = [...changes].sort((a, b) => CHANGE_PRIORITY[a.kind] - CHANGE_PRIORITY[b.kind])
		trimmed = {
			...trimmed,
			details: {
				...report.details,
				changesByKind: countByKind(changes),
				changes: ranked.slice(0, MAX_CHANGES),
				...(changes.length > MAX_CHANGES ? { changesOmitted: changes.length - MAX_CHANGES } : {})
			}
		}
	}
	return trimmed
}

/** Warn when the plugin loaded in Obsidian is not the version this file expects. */
function withVersionWarning(payload) {
	if (typeof payload?.apiVersion !== 'number' || payload.apiVersion === EXPECTED_API_VERSION) {
		return payload
	}
	return {
		...payload,
		warning: `The plugin serves API v${payload.apiVersion} but this bridge expects v${EXPECTED_API_VERSION}. Update the plugin and reload it in Obsidian; some tools may fail until then.`
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
		// The API names the route it does not know: this plugin build is older than the bridge.
		return /^Unknown route/.test(detail)
			? `The plugin loaded in Obsidian does not have this tool yet (${detail}). Update the plugin and reload it.`
			: detail || `Not found at ${baseUrl}.`
	}
	return `Plugin API error ${status}: ${detail || 'no details'}`
}

/**
 * Build the message handler. `env` and `fetchImpl` are injectable so tests
 * never touch the network or process state. Returns a function that maps one
 * JSON-RPC message to a response object, or undefined for notifications.
 */
export function createHandler({ env = process.env, fetchImpl = fetch } = {}) {
	let negotiatedProtocol

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
		return dataResult(trimReport(withVersionWarning(payload)))
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
				negotiatedProtocol = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0]
				return ok({
					protocolVersion: negotiatedProtocol,
					capabilities: { tools: {} },
					serverInfo: SERVER_INFO,
					instructions: INSTRUCTIONS
				})
			}
			case 'ping':
				return ok({})
			case 'tools/list':
				return ok({
					tools: TOOLS.map(({ name, title, description, inputSchema, annotations, outputSchema }) => ({
						name,
						title,
						description,
						inputSchema,
						annotations,
						// An older client may not expect a contract it has never heard of.
						...(negotiatedProtocol === STRUCTURED_OUTPUT_PROTOCOL ? { outputSchema } : {})
					}))
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
