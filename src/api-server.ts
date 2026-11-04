import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AnkiProbe } from './anki-launch'
import type { ScanReport } from './scan-orchestrator'
import type { ValidationReport } from './validate'

/** Bump when a response shape changes incompatibly (the MCP checks it). */
export const API_VERSION = 2

/** Tokens shorter than this are refused: the API can write to the vault. */
export const MIN_TOKEN_LENGTH = 24

const MAX_BODY_BYTES = 16 * 1024
/** Validation can receive a whole unsaved file. */
const MAX_VALIDATE_BODY_BYTES = 1024 * 1024
const MAX_PATH_LENGTH = 1024

/**
 * What the API may do. The plugin wires these to the same code paths the
 * commands use; this module knows nothing about Obsidian.
 */
export interface ApiHandlers {
	status(): Promise<AnkiProbe>
	scan(): Promise<ScanReport>
	/** null when the path is not a file in the vault. */
	scanFile(path: string): Promise<ScanReport | null>
	/** Read-only preview; a path narrows it to one file. null when not found. */
	dryRun(path?: string): Promise<ScanReport | null>
	/**
	 * Check card syntax of the vault, a file, or text that is not saved. With
	 * `content`, `path` only labels the result. null when `path` alone names no file.
	 */
	validate(target: { path?: string; content?: string }): Promise<ValidationReport | null>
}

export interface ApiServerConfig {
	/** 0 picks a free port (tests). */
	port: number
	token: string
	handlers: ApiHandlers
}

export function generateToken(): string {
	return randomBytes(24).toString('base64url')
}

/**
 * Forms a vault path may be spelled in, the given one first. macOS filenames
 * are often NFD while Obsidian indexes NFC, so a path copied from a directory
 * listing would otherwise miss a file that exists.
 */
export function pathForms(path: string): string[] {
	return [...new Set([path, path.normalize('NFC'), path.normalize('NFD')])]
}

function sha256(value: string): Buffer {
	return createHash('sha256').update(value).digest()
}

/** Constant-time compare that does not leak the token length. */
function tokenMatches(expected: string, presented: string): boolean {
	return timingSafeEqual(sha256(expected), sha256(presented))
}

function send(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body)
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(payload),
		'Cache-Control': 'no-store'
	})
	res.end(payload)
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message)
	}
}

async function readJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = []
	let size = 0
	for await (const chunk of req) {
		const buffer = chunk as Buffer
		size += buffer.length
		if (size > maxBytes) {
			throw new HttpError(413, 'Request body too large.')
		}
		chunks.push(buffer)
	}
	if (size === 0) {
		return {}
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
	} catch {
		throw new HttpError(400, 'Body must be valid JSON.')
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new HttpError(400, 'Body must be a JSON object.')
	}
	return parsed as Record<string, unknown>
}

function readPath(body: Record<string, unknown>, required: boolean): string | undefined {
	const value = body['path']
	if (value === undefined) {
		if (required) {
			throw new HttpError(400, '"path" (vault-relative file path) is required.')
		}
		return undefined
	}
	if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_PATH_LENGTH) {
		throw new HttpError(400, '"path" must be a non-empty vault-relative string.')
	}
	return value
}

/** HTTP status for a finished scan: only real conflicts/unavailability are errors. */
function statusForReport(report: ScanReport): number {
	if (report.outcome === 'busy') {
		return 409
	}
	if (report.outcome === 'aborted') {
		return 503
	}
	return 200
}

/**
 * Loopback-only HTTP API that lets an external agent (via the MCP bridge)
 * trigger scans without the Obsidian CLI. Every request needs the bearer
 * token; the Host header must be loopback (DNS-rebinding guard). Disabled by
 * default in the plugin settings.
 */
export class LocalApiServer {
	private server: Server | undefined

	constructor(private readonly config: ApiServerConfig) {
		if (config.token.length < MIN_TOKEN_LENGTH) {
			throw new Error(`API token must be at least ${MIN_TOKEN_LENGTH} characters.`)
		}
	}

	/** The bound port (differs from config.port when that was 0). */
	get port(): number {
		const address = this.server?.address()
		return typeof address === 'object' && address !== null ? address.port : this.config.port
	}

	start(): Promise<void> {
		return new Promise((resolve, reject) => {
			const server = createServer((req, res) => void this.handle(req, res))
			server.once('error', reject)
			// 127.0.0.1 explicitly: never expose the vault on the LAN.
			server.listen(this.config.port, '127.0.0.1', () => {
				server.off('error', reject)
				this.server = server
				resolve()
			})
		})
	}

	stop(): Promise<void> {
		const server = this.server
		this.server = undefined
		if (!server) {
			return Promise.resolve()
		}
		return new Promise((resolve) => {
			server.close(() => resolve())
			server.closeAllConnections()
		})
	}

	private isLoopbackHost(host: string | undefined): boolean {
		if (!host) {
			return false
		}
		const port = this.port
		return host === `127.0.0.1:${port}` || host === `localhost:${port}`
	}

	private isAuthorized(req: IncomingMessage): boolean {
		const header = req.headers.authorization
		if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
			return false
		}
		return tokenMatches(this.config.token, header.slice('Bearer '.length))
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			if (!this.isLoopbackHost(req.headers.host)) {
				throw new HttpError(403, 'Forbidden host.')
			}
			if (!this.isAuthorized(req)) {
				res.setHeader('WWW-Authenticate', 'Bearer')
				throw new HttpError(401, 'Missing or invalid bearer token.')
			}
			const route = new URL(req.url ?? '/', 'http://localhost').pathname
			await this.route(req, res, route)
		} catch (error) {
			if (error instanceof HttpError) {
				send(res, error.status, { error: error.message })
				return
			}
			console.error('[Obsidian_to_Anki] local API error:', error)
			send(res, 500, { error: error instanceof Error ? error.message : 'Internal error.' })
		}
	}

	private async route(req: IncomingMessage, res: ServerResponse, route: string): Promise<void> {
		const { handlers } = this.config
		const method = req.method ?? 'GET'
		const expectMethod = (allowed: 'GET' | 'POST'): void => {
			if (method !== allowed) {
				res.setHeader('Allow', allowed)
				throw new HttpError(405, `Use ${allowed} for ${route}.`)
			}
		}

		switch (route) {
			case '/status': {
				expectMethod('GET')
				send(res, 200, { apiVersion: API_VERSION, anki: await handlers.status() })
				return
			}
			case '/scan': {
				expectMethod('POST')
				await readJsonBody(req)
				const report = await handlers.scan()
				send(res, statusForReport(report), report)
				return
			}
			case '/scan-file': {
				expectMethod('POST')
				const path = readPath(await readJsonBody(req), true) as string
				const report = await handlers.scanFile(path)
				if (report === null) {
					throw new HttpError(404, `Not a file in this vault: ${path}`)
				}
				send(res, statusForReport(report), report)
				return
			}
			case '/dry-run': {
				expectMethod('POST')
				const path = readPath(await readJsonBody(req), false)
				const report = await handlers.dryRun(path)
				if (report === null) {
					throw new HttpError(404, `Not a file in this vault: ${path}`)
				}
				send(res, statusForReport(report), report)
				return
			}
			case '/validate': {
				expectMethod('POST')
				const body = await readJsonBody(req, MAX_VALIDATE_BODY_BYTES)
				const path = readPath(body, false)
				const content = body['content']
				if (content !== undefined && typeof content !== 'string') {
					throw new HttpError(400, '"content" must be a string.')
				}
				const report = await handlers.validate({ path, content })
				if (report === null) {
					throw new HttpError(404, `Not a file in this vault: ${path}`)
				}
				send(res, 200, report)
				return
			}
			default:
				throw new HttpError(404, `Unknown route ${route}.`)
		}
	}
}
