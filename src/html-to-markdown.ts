/**
 * Turns the HTML of an Anki field into the Markdown this plugin renders back.
 *
 * Both directions share one reading of the HTML (`readHtml`), so the import can
 * check its own work: render the Markdown with the real formatter and compare
 * `canonicalHtml` of both sides. A note that differs stays in Anki.
 */

type Style = 'b' | 'i' | 'u' | 'sub' | 'sup'

const STYLE_ORDER: readonly Style[] = ['u', 'sub', 'sup', 'b', 'i']

const STYLE_TAGS: Readonly<Record<string, Style>> = {
	b: 'b',
	strong: 'b',
	i: 'i',
	em: 'i',
	u: 'u',
	sub: 'sub',
	sup: 'sup'
}

/** Tags that only separate lines. */
const BLOCK_TAGS: ReadonlySet<string> = new Set(['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote'])
const IGNORED_TAGS: ReadonlySet<string> = new Set(['span', 'font', 'meta', 'link', 'style'])

interface TextRun {
	kind: 'text'
	text: string
	styles: Style[]
	href?: string
}

interface ImageRun {
	kind: 'image'
	src: string
	width?: string
}

type Run = TextRun | ImageRun

interface Line {
	runs: Run[]
	/** Set on the first line of a list item. */
	bullet?: { depth: number; ordered: boolean }
	/** Inside a list item, after its first line. */
	inList: boolean
	/** Blank lines' worth of separation before this line: 1 is a plain line break. */
	gap: number
}

interface ReadResult {
	lines: Line[]
	/** Tags with no Markdown form: the note cannot be converted faithfully. */
	unsupported: string[]
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' '
}

function decodeEntities(text: string): string {
	return text.replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (whole, code: string) => {
		if (code.startsWith('#')) {
			const isHex = code[1] === 'x' || code[1] === 'X'
			const value = parseInt(code.slice(isHex ? 2 : 1), isHex ? 16 : 10)
			return Number.isNaN(value) ? whole : String.fromCodePoint(value)
		}
		return NAMED_ENTITIES[code.toLowerCase()] ?? whole
	})
}

function attribute(attributes: string, name: string): string | undefined {
	const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attributes)
	const value = match?.[1] ?? match?.[2] ?? match?.[3]
	return value === undefined ? undefined : decodeEntities(value)
}

interface InlineCss {
	adds: Style[]
	/** A nested span can switch off what an outer one switched on. */
	removes: Style[]
}

function cssStyles(attributes: string): InlineCss {
	const css = attribute(attributes, 'style')?.toLowerCase() ?? ''
	const adds: Style[] = []
	const removes: Style[] = []
	const weight = /font-weight:\s*([a-z0-9]+)/.exec(css)?.[1]
	if (weight !== undefined) {
		;(weight === 'bold' || weight === 'bolder' || parseInt(weight, 10) >= 600 ? adds : removes).push('b')
	}
	const slant = /font-style:\s*([a-z]+)/.exec(css)?.[1]
	if (slant !== undefined) {
		;(slant === 'italic' || slant === 'oblique' ? adds : removes).push('i')
	}
	const decoration = /text-decoration(?:-line)?:\s*([a-z ]+)/.exec(css)?.[1]
	if (decoration !== undefined) {
		;(decoration.includes('underline') ? adds : removes).push('u')
	}
	return { adds, removes }
}

const TOKEN = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g

/** Reads field HTML into lines of styled text and images. */
function readHtml(html: string): ReadResult {
	const lines: Line[] = []
	const unsupported = new Set<string>()
	const open: Array<{ tag: string; css: InlineCss; href?: string }> = []
	const lists: boolean[] = []
	let line: Line = { runs: [], inList: false, gap: 0 }

	const hasContent = (): boolean => line.runs.length > 0 || line.bullet !== undefined
	const nextLine = (gap: number): void => {
		lines.push(line)
		line = { runs: [], inList: lists.length > 0, gap }
	}
	/** A block edge: starts a new line, but adjacent edges do not add up. */
	const blockEdge = (gap: number): void => {
		if (line.bullet !== undefined && line.runs.length === 0) {
			return // `<li><div>text</div></li>`: the text belongs on the bullet's line.
		}
		if (hasContent()) {
			nextLine(gap)
		} else {
			line.gap = Math.max(line.gap, gap)
			line.inList = lists.length > 0
		}
	}
	/** List markup always starts a line, even after a bullet with no text of its own. */
	const listEdge = (): void => {
		if (hasContent()) {
			nextLine(1)
		} else {
			line.gap = Math.max(line.gap, 1)
		}
	}
	/** A `<br>`: ends the line, and on an empty line it adds a blank one. */
	const lineBreak = (): void => {
		if (line.bullet !== undefined && line.runs.length === 0) {
			return // Nothing to end yet: a list item starting with a break looks the same without it.
		}
		if (hasContent()) {
			nextLine(1)
		} else {
			line.gap += 1
		}
	}
	const addText = (raw: string): void => {
		const text = decodeEntities(raw).replace(/\s+/g, ' ')
		if (text === '') {
			return
		}
		const active = new Set<Style>()
		for (const { css } of open) {
			css.adds.forEach((style) => active.add(style))
			css.removes.forEach((style) => active.delete(style))
		}
		const styles = [...active]
		const href = [...open].reverse().find((entry) => entry.href !== undefined)?.href
		line.runs.push({ kind: 'text', text, styles, ...(href === undefined ? {} : { href }) })
	}

	let cursor = 0
	for (const match of html.matchAll(TOKEN)) {
		addText(html.slice(cursor, match.index))
		cursor = match.index + match[0].length
		const tag = match[2]?.toLowerCase()
		if (tag === undefined) {
			continue
		}
		const closing = match[1] === '/'
		const attributes = match[3] ?? ''
		if (tag === 'br') {
			lineBreak()
		} else if (tag === 'img') {
			const src = attribute(attributes, 'src')
			if (src === undefined) {
				unsupported.add('img without src')
				continue
			}
			const width = attribute(attributes, 'width')
			const isPixels = width !== undefined && /^\d+$/.test(width)
			line.runs.push({ kind: 'image', src, ...(isPixels ? { width } : {}) })
		} else if (tag === 'ul' || tag === 'ol') {
			listEdge()
			if (closing) {
				lists.pop()
			} else {
				lists.push(tag === 'ol')
			}
			line.inList = lists.length > 0
		} else if (tag === 'li') {
			listEdge()
			line.inList = lists.length > 0
			if (!closing) {
				line.bullet = { depth: Math.max(lists.length - 1, 0), ordered: lists[lists.length - 1] ?? false }
			}
		} else if (BLOCK_TAGS.has(tag)) {
			blockEdge(tag === 'p' ? 2 : 1)
		} else if (closing) {
			const at = open.map((entry) => entry.tag).lastIndexOf(tag)
			if (at >= 0) {
				open.splice(at, 1)
			}
		} else {
			const named = STYLE_TAGS[tag]
			const fromCss = cssStyles(attributes)
			const css = named === undefined ? fromCss : { ...fromCss, adds: [named, ...fromCss.adds] }
			if (tag === 'a') {
				const href = attribute(attributes, 'href')
				open.push({ tag, css, ...(href === undefined ? {} : { href }) })
			} else if (named !== undefined || IGNORED_TAGS.has(tag)) {
				open.push({ tag, css })
			} else {
				unsupported.add(tag)
			}
		}
	}
	addText(html.slice(cursor))
	if (hasContent()) {
		lines.push(line)
	}
	return {
		lines: lines.map(tidyLine).filter((entry) => entry.runs.length > 0 || entry.bullet),
		unsupported: [...unsupported]
	}
}

/** Joins equal neighbours and drops the spaces a browser would not show at a line's edges. */
function tidyLine(line: Line): Line {
	const runs: Run[] = []
	for (const run of line.runs) {
		const last = runs[runs.length - 1]
		if (
			run.kind === 'text' &&
			last?.kind === 'text' &&
			last.href === run.href &&
			sameStyles(last.styles, run.styles)
		) {
			last.text = (last.text + run.text).replace(/ {2,}/g, ' ')
		} else {
			runs.push(run.kind === 'text' ? { ...run } : run)
		}
	}
	const first = runs[0]
	if (first?.kind === 'text') {
		first.text = first.text.replace(/^ +/, '')
	}
	const last = runs[runs.length - 1]
	if (last?.kind === 'text') {
		last.text = last.text.replace(/ +$/, '')
	}
	return { ...line, runs: runs.filter((run) => run.kind !== 'text' || run.text !== '') }
}

function sameStyles(a: Style[], b: Style[]): boolean {
	return a.length === b.length && a.every((style) => b.includes(style))
}

/**
 * What a reader sees, in a form two renderings can be compared in: line breaks,
 * list items, styled text and image names. Spacing that only changes the look
 * (a third blank line, non-breaking spaces, image alt) does not count.
 */
export function canonicalHtml(html: string): string {
	const { lines } = readHtml(html)
	const out: string[] = []
	lines.forEach((line, index) => {
		if (index > 0) {
			const listEdge = line.bullet !== undefined || line.inList || lines[index - 1].inList
			out.push(line.gap >= 2 && !listEdge ? '\n\n' : '\n')
		}
		if (line.bullet) {
			out.push(`${'  '.repeat(line.bullet.depth)}${line.bullet.ordered ? '1.' : '-'} `)
		}
		out.push(canonicalRuns(line.runs))
	})
	return out.join('')
}

/** Styles apply word by word, so a space inside or outside a marker reads the same. */
function canonicalRuns(runs: Run[]): string {
	const pieces: Array<{ label: string; text: string }> = []
	for (const run of runs) {
		if (run.kind === 'image') {
			pieces.push({ label: '', text: `[image ${run.src}${run.width === undefined ? '' : ` ${run.width}`}]` })
			continue
		}
		const link = run.href !== undefined && !isSelfLink(run.href, run.text) ? ` ${run.href}` : ''
		const label = STYLE_ORDER.filter((style) => run.styles.includes(style)).join('+') + link
		for (const part of run.text.split(/( +)/)) {
			const last = pieces[pieces.length - 1]
			if (part === '') {
				continue
			}
			if (part.startsWith(' ')) {
				pieces.push({ label: '', text: ' ' })
			} else if (last !== undefined && last.label === label && last.text !== ' ') {
				last.text += part
			} else {
				pieces.push({ label, text: part })
			}
		}
	}
	return pieces
		.map((piece) => (piece.label === '' ? piece.text : `[${piece.label}|${piece.text}]`))
		.join('')
		.replace(/ {2,}/g, ' ')
		.trim()
}

/** A bare URL in the text comes back as a link: the reader sees the same words. */
function isSelfLink(href: string, text: string): boolean {
	const bare = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\/$/, '')
	return bare(href) === bare(text.trim())
}

const MATH = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g

function escapePlain(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/\\/g, '\\\\')
		.replace(/\*/g, '\\*')
		.replace(/`/g, '\\`')
		.replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, '\\_')
		.replace(/\[(?=[^\]]*\]\()/g, '\\[')
		.replace(/(^|\s)#/g, '$1&#35;')
		.replace(/\$/g, '&#36;')
		.replace(/(?<!\{)\{(?!\{)/g, '&#123;')
		.replace(/(?<!\})\}(?!\})/g, '&#125;')
}

/** Escapes what means something to Showdown or the plugin; math becomes Obsidian's `$`. */
function escapeText(text: string): string {
	let out = ''
	let cursor = 0
	for (const match of text.matchAll(MATH)) {
		out += escapePlain(text.slice(cursor, match.index))
		out += match[1] === undefined ? `$$${(match[2] ?? '').trim()}$$` : `$${match[1].trim()}$`
		cursor = match.index + match[0].length
	}
	return out + escapePlain(text.slice(cursor))
}

function escapeLineStart(line: string): string {
	return line
		.replace(/^([-+]) /, '\\$1 ')
		.replace(/^(-{3,}|={3,})$/, (marks) => `\\${marks}`)
		.replace(/^(\d+)\. /, '$1\\. ')
		.replace(/^>/, '\\>')
}

function imageMarkdown(run: ImageRun): string {
	if (/^[a-z][a-z\d+.-]*:/i.test(run.src)) {
		// Obsidian has a size syntax for embeds only, so a sized web image stays as HTML.
		return run.width === undefined
			? `![](${run.src})`
			: `<img src="${run.src.replace(/&/g, '&amp;')}" width="${run.width}">`
	}
	return run.width === undefined ? `![[${run.src}]]` : `![[${run.src}|${run.width}]]`
}

/** Wraps text in its styles, keeping the spaces outside the markers. */
function styledText(run: TextRun, useTags: boolean): string {
	const lead = /^ */.exec(run.text)?.[0] ?? ''
	const trail = run.text.length > lead.length ? (/ *$/.exec(run.text)?.[0] ?? '') : ''
	const body = run.text.slice(lead.length, run.text.length - trail.length)
	if (body === '') {
		return run.text
	}
	let text = escapeText(body)
	if (run.href !== undefined) {
		text = `[${text}](${run.href})`
	}
	for (const style of [...STYLE_ORDER].reverse()) {
		if (run.styles.includes(style)) {
			const marker = useTags ? undefined : style === 'b' ? '**' : style === 'i' ? '*' : undefined
			text = marker === undefined ? `<${style}>${text}</${style}>` : `${marker}${text}${marker}`
		}
	}
	return `${lead}${text}${trail}`
}

function hasMarker(run: Run | undefined): boolean {
	return run?.kind === 'text' && !run.text.startsWith(' ') && (run.styles.includes('b') || run.styles.includes('i'))
}

function lineMarkdown(line: Line): string {
	const parts = line.runs.map((run, index) => {
		if (run.kind === 'image') {
			return imageMarkdown(run)
		}
		// `**a***b*` reads ambiguously: touching styled runs use plain tags.
		const touching =
			hasMarker(run) &&
			((hasMarker(line.runs[index + 1]) && !run.text.endsWith(' ')) ||
				(hasMarker(line.runs[index - 1]) && !(line.runs[index - 1] as TextRun).text.endsWith(' ')))
		return styledText(run, touching)
	})
	return parts.join('')
}

export interface ConvertedField {
	markdown: string
	unsupported: string[]
}

/** Converts one field. Check `unsupported` and compare renderings before trusting it. */
export function htmlToMarkdown(html: string): ConvertedField {
	const { lines, unsupported } = readHtml(html)
	let markdown = ''
	lines.forEach((line, index) => {
		const body = lineMarkdown(line)
		if (line.bullet) {
			const separator = index === 0 ? '' : lines[index - 1].inList ? '\n' : '\n\n'
			markdown += `${separator}${'    '.repeat(line.bullet.depth)}${line.bullet.ordered ? '1.' : '-'} ${body}`
		} else if (line.inList) {
			markdown += index === 0 ? body : `<br>${body}`
		} else {
			const afterList = index > 0 && lines[index - 1].inList
			const separator = index === 0 ? '' : afterList || line.gap >= 2 ? '\n\n' : '\n'
			markdown += separator + escapeLineStart(body)
		}
	})
	return { markdown, unsupported }
}

/** Lines the block parser would read as structure: their first letter becomes an entity. */
export function protectLineStarts(markdown: string, reserved: readonly string[]): string {
	return markdown
		.split('\n')
		.map((line) =>
			reserved.some((word) => line.startsWith(word)) ? `&#${line.codePointAt(0)};${line.slice(1)}` : line
		)
		.join('\n')
}
