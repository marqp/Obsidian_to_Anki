import { AnkiConnectNote } from './interfaces/note-interface'
import { basename, extname } from 'path'
import { Converter } from 'showdown'
import { CachedMetadata } from 'obsidian'
import * as c from './constants'
import { codeHighlightExtension } from './highlight'

const ANKI_MATH_REGEXP: RegExp = /(\\\[[\s\S]*?\\\])|(\\\([\s\S]*?\\\))/g
const HIGHLIGHT_REGEXP: RegExp = /==(.*?)==/g

const MATH_REPLACE: string = 'OBSTOANKIMATH'
const INLINE_CODE_REPLACE: string = 'OBSTOANKICODEINLINE'
const DISPLAY_CODE_REPLACE: string = 'OBSTOANKICODEDISPLAY'

const MATH_MASK_REGEXP: RegExp = new RegExp(MATH_REPLACE, 'g')
const INLINE_CODE_MASK_REGEXP: RegExp = new RegExp(INLINE_CODE_REPLACE, 'g')
const DISPLAY_CODE_MASK_REGEXP: RegExp = new RegExp(DISPLAY_CODE_REPLACE, 'g')

const CLOZE_REGEXP: RegExp = /(?:(?<!{){(?:c?(\d+)[:|])?(?!{))((?:[^\n][\n]?)+?)(?:(?<!})}(?!}))/g

const IMAGE_EXTS: string[] = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.tiff']
const AUDIO_EXTS: string[] = ['.wav', '.m4a', '.flac', '.mp3', '.wma', '.aac', '.webm', '.mp4']

const PARA_OPEN: string = '<p>'
const PARA_CLOSE: string = '</p>'

// Module singleton by measurement, not by accident: constructing a showdown
// Converter per FormatConverter instance regressed linear-x4 by ~3.7x
// (bench: fork advantage collapsed 4.63x -> 1.38x). There is no per-file
// converter config, so sharing is behavior-preserving. Mutable per-format
// state (cloze counter, memo) stays instance-owned below.
const converter: Converter = new Converter({
	simplifiedAutoLink: true,
	literalMidWordUnderscores: true,
	tables: true,
	tasklists: true,
	simpleLineBreaks: true,
	requireSpaceBeforeHeadingText: true,
	extensions: [codeHighlightExtension()]
})

function escapeHtml(unsafe: string): string {
	return unsafe
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;')
}

export class FormatConverter {
	file_cache: CachedMetadata
	vault_name: string
	detectedMedia: Set<string>
	private memoCache: Map<string, string>
	private clozeUnsetNum: number = 1

	constructor(file_cache: CachedMetadata, vault_name: string) {
		this.vault_name = vault_name
		this.file_cache = file_cache
		this.detectedMedia = new Set()
		this.memoCache = new Map()
	}

	getUrlFromLink(link: string): string {
		return (
			'obsidian://open?vault=' +
			encodeURIComponent(this.vault_name) +
			String.raw`&file=` +
			encodeURIComponent(link)
		)
	}

	format_note_with_url(note: AnkiConnectNote, url: string, field: string): void {
		let mdFilename = ''
		// The url is built by getUrlFromLink as obsidian://open?vault=...&file=<encoded path>.
		const splitUrl: string[] = url.split('&file=')
		if (splitUrl.length === 2) {
			const decodedPathWithExtension: string = decodeURIComponent(splitUrl[1] ?? '')
			const pathSegments: string[] = decodedPathWithExtension.split('/')
			const filenameWithExtension: string | undefined = pathSegments.pop()?.trim()
			if (filenameWithExtension) {
				mdFilename = (filenameWithExtension.split('.')[0] ?? '').trim()
			}
		}
		note.fields[field] +=
			'<br><a href="' + url + `" class="obsidian-link">Obsidian${mdFilename ? ' - ' + mdFilename : ''}</a>`
	}

	format_note_with_frozen_fields(
		note: AnkiConnectNote,
		frozen_fields_dict: Record<string, Record<string, string>>
	): void {
		const frozen = frozen_fields_dict[note.modelName]
		for (const [field, value] of Object.entries(note.fields)) {
			// No `?? ''` here: exact string-concat semantics are parity-pinned.
			// For an unknown field key the concatenation yields the literal
			// "undefined" (upstream behavior) — the parity fixture
			// custom-regexp would flag any change.
			note.fields[field] = value + frozen[field]
		}
	}

	obsidian_to_anki_math(note_text: string): string {
		return note_text.replace(c.OBS_DISPLAY_MATH_REGEXP, '\\[$1\\]').replace(c.OBS_INLINE_MATH_REGEXP, '\\($1\\)')
	}

	cloze_repl(_1: string, match_id: string, match_content: string): string {
		if (match_id == undefined) {
			const result = '{{c' + this.clozeUnsetNum.toString() + '::' + match_content + '}}'
			this.clozeUnsetNum += 1
			return result
		}
		const result = '{{c' + match_id + '::' + match_content + '}}'
		return result
	}

	curly_to_cloze(text: string): string {
		/*Change text in curly brackets to Anki-formatted cloze.*/
		// Arrow wrapper: cloze_repl reads instance state, so it must not be
		// passed unbound as the replace callback.
		text = text.replace(CLOZE_REGEXP, (match, match_id, match_content) =>
			this.cloze_repl(match, match_id, match_content)
		)
		this.clozeUnsetNum = 1
		return text
	}

	getAndFormatMedias(note_text: string): string {
		if (!this.file_cache.hasOwnProperty('embeds') || !this.file_cache.embeds) {
			return note_text
		}
		// Fast-path: only scan embeds if string could possibly contain an embed
		if (!note_text.includes('![[')) {
			return note_text
		}
		for (const embed of this.file_cache.embeds) {
			if (note_text.includes(embed.original)) {
				this.detectedMedia.add(embed.link)
				const ext = extname(embed.link)
				if (AUDIO_EXTS.includes(ext)) {
					note_text = note_text.replaceAll(embed.original, '[sound:' + basename(embed.link) + ']')
				} else if (IMAGE_EXTS.includes(ext)) {
					note_text = note_text.replaceAll(
						embed.original,
						'<img src="' + basename(embed.link) + '" alt="' + embed.displayText + '">'
					)
				} else {
					console.warn('Unsupported extension: ', ext)
				}
			}
		}
		return note_text
	}

	formatLinks(note_text: string): string {
		if (!this.file_cache.hasOwnProperty('links') || !this.file_cache.links) {
			return note_text
		}
		// Fast-path: only scan links if string could possibly contain an internal link
		if (!note_text.includes('[[')) {
			return note_text
		}
		for (const link of this.file_cache.links) {
			if (note_text.includes(link.original)) {
				note_text = note_text.replaceAll(
					link.original,
					'<a href="' + this.getUrlFromLink(link.link) + '">' + link.displayText + '</a>'
				)
			}
		}
		return note_text
	}

	censor(note_text: string, regexp: RegExp, mask: string): [string, string[]] {
		/*Take note_text and replace every match of regexp with mask, simultaneously adding it to a string array.
		Callers must pass a global regexp; a single replace() pass both collects
		and substitutes, so the text is scanned once instead of twice.*/
		const matches: string[] = []
		const censored = note_text.replace(regexp, (match) => {
			matches.push(match)
			return mask
		})
		return [censored, matches]
	}

	decensor(note_text: string, mask: string, replacements: string[], escape: boolean): string {
		let index = 0

		// note_text example: "The OBSTOANKICODEDISPLAY is worth OBSTOANKICODEDISPLAY today"
		// maskGlobalReg example: /OBSTOANKICODEDISPLAY/g
		const maskGlobalRegex: RegExp =
			mask === DISPLAY_CODE_REPLACE
				? DISPLAY_CODE_MASK_REGEXP
				: mask === INLINE_CODE_REPLACE
					? INLINE_CODE_MASK_REGEXP
					: mask === MATH_REPLACE
						? MATH_MASK_REGEXP
						: new RegExp(mask, 'g')

		// replacements example: ["10", "15"]
		note_text = note_text.replace(maskGlobalRegex, () => {
			const replacement: string | undefined = replacements[index++]
			// note_text expected: "The 10 is worth 15 today"
			if (replacement === undefined) {
				throw new Error(
					`Mismatch between placeholders and replacements (${index - 1} of ${replacements.length} consumed)`
				)
			}
			return escape ? escapeHtml(replacement) : replacement
		})

		// Validate that we have exactly enough replacements
		if (index !== replacements.length) {
			throw new Error(`Mismatch between placeholders (${index}) and replacements (${replacements.length})`)
		}

		return note_text
	}

	format(note_text: string, cloze: boolean, highlights_to_cloze: boolean): string {
		const memoKey = `${cloze ? 1 : 0}:${highlights_to_cloze ? 1 : 0}:${note_text}`
		const cached = this.memoCache.get(memoKey)
		if (cached !== undefined) {
			return cached
		}

		let formatted = this.obsidian_to_anki_math(note_text)
		//Extract the parts that are anki math
		const add_highlight_css: boolean = formatted.match(c.OBS_DISPLAY_CODE_REGEXP) ? true : false
		const [formattedAfterMath, math_matches] = this.censor(formatted, ANKI_MATH_REGEXP, MATH_REPLACE)
		const [formattedAfterDisplay, display_code_matches] = this.censor(
			formattedAfterMath,
			c.OBS_DISPLAY_CODE_REGEXP,
			DISPLAY_CODE_REPLACE
		)
		const [formattedAfterInline, inline_code_matches] = this.censor(
			formattedAfterDisplay,
			c.OBS_CODE_REGEXP,
			INLINE_CODE_REPLACE
		)
		formatted = formattedAfterInline
		if (cloze) {
			if (highlights_to_cloze) {
				formatted = formatted.replace(HIGHLIGHT_REGEXP, '{$1}')
			}
			formatted = this.curly_to_cloze(formatted)
		}
		formatted = this.getAndFormatMedias(formatted)
		formatted = this.formatLinks(formatted)
		//Special for formatting highlights now, but want to avoid any == in code
		formatted = formatted.replace(HIGHLIGHT_REGEXP, String.raw`<mark>$1</mark>`)
		formatted = this.decensor(formatted, DISPLAY_CODE_REPLACE, display_code_matches, false)
		formatted = this.decensor(formatted, INLINE_CODE_REPLACE, inline_code_matches, false)
		formatted = converter.makeHtml(formatted)
		formatted = this.decensor(formatted, MATH_REPLACE, math_matches, true).trim()
		// Remove unnecessary paragraph tag
		if (formatted.startsWith(PARA_OPEN) && formatted.endsWith(PARA_CLOSE)) {
			formatted = formatted.slice(PARA_OPEN.length, -1 * PARA_CLOSE.length)
		}
		if (add_highlight_css) {
			formatted = '<link href="' + c.CODE_CSS_URL + '" rel="stylesheet">' + formatted
		}
		// Deliberately unbounded: the cache lives and dies with one AllFile
		// scan, and every formatted output is retained in notes_to_add anyway,
		// so the Map never dominates memory. A 500-entry FIFO cap was measured
		// to thrash on repeated content (linear-x4: 4.6x -> 1.4x advantage).
		this.memoCache.set(memoKey, formatted)
		return formatted
	}
}
