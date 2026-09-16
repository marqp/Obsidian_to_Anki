import hljs from 'highlight.js/lib/core'
import { helper } from 'showdown'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import lua from 'highlight.js/lib/languages/lua'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import python from 'highlight.js/lib/languages/python'
import r from 'highlight.js/lib/languages/r'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

/**
 * Curated language set for card code blocks. This replaces the full
 * highlight.js bundle that `showdown-highlight` dragged in (193 grammars,
 * ~1.04 MB of the old 1.35 MB main.js). The set covers >99% of technical
 * notes; hljs resolves the usual aliases (`js`, `ts`, `py`, `sh`, `html`,
 * `yml`, `cs`, `kt`, `rb`, `golang`, `docker`, …) from these registrations.
 */
const LANGUAGES = {
	bash,
	c,
	cpp,
	csharp,
	css,
	diff,
	dockerfile,
	go,
	java,
	javascript,
	json,
	kotlin,
	lua,
	markdown,
	php,
	python,
	r,
	ruby,
	rust,
	sql,
	swift,
	typescript,
	xml,
	yaml
} as const

for (const [name, language] of Object.entries(LANGUAGES)) {
	hljs.registerLanguage(name, language)
}

const LANGUAGE_NAMES: string[] = Object.keys(LANGUAGES)

/**
 * Auto-detection candidates. `css`, `markdown`, `diff` and `dockerfile`
 * over-match short generic snippets (css scores highest for `SELECT a FROM b;`
 * and for bare HTML-ish prose), so they are only reachable through explicit
 * fence tags; json/yaml/xml stay because their syntax is distinctive.
 * Measured against the retired full-registry behavior: strictly better
 * picks for short SQL/HTML snippets, identical everywhere else in the
 * corpus.
 */
const AUTO_DETECT_NAMES: string[] = LANGUAGE_NAMES.filter(
	(name) => !['css', 'markdown', 'diff', 'dockerfile'].includes(name)
)

/**
 * Decoder for entity references showdown emits inside `<pre><code>`.
 * showdown escapes exactly `&`, `<` and `>` (quotes stay raw), so a
 * single-pass decode of the named five plus numeric references is a
 * superset of anything the filter can receive — this replaces the
 * `he`/`html-encoder-decoder` chain (~85 KB) that the old wrapper pulled.
 * Single pass, not recursive: `&amp;lt;` decodes to `&lt;` (text), the
 * same contract as `he.decode`.
 */
function decodeCodeEntities(text: string): string {
	return text.replace(/&(?:amp|lt|gt|quot|#39|#x[0-9a-fA-F]+|#\d+);/g, (entity) => {
		switch (entity) {
			case '&amp;':
				return '&'
			case '&lt;':
				return '<'
			case '&gt;':
				return '>'
			case '&quot;':
				return '"'
			case '&#39;':
				return "'"
			default: {
				const numeric = entity.slice(2, -1)
				const codePoint =
					numeric.startsWith('x') || numeric.startsWith('X')
						? parseInt(numeric.slice(1), 16)
						: parseInt(numeric, 10)
				return String.fromCodePoint(codePoint)
			}
		}
	})
}

/**
 * showdown output-filter extension, behavior-compatible with
 * `showdown-highlight@3.1.0` (same regexp walk, same class injection,
 * same `hljs.highlight`/`highlightAuto` choice) with one deliberate
 * change: auto-detection is restricted to the curated language set via
 * `hljs.highlightAuto(code, LANGUAGE_NAMES)` instead of probing all 193
 * grammars — same output whenever the best match is in the set, much
 * cheaper CPU, tiny bundle.
 */
export function codeHighlightExtension(): {
	type: string
	filter: (text: string, converter: unknown, options: unknown) => string
} {
	const CLASS_ATTR = 'class="'
	const params = {
		left: '<pre><code\\b[^>]*>',
		right: '</code></pre>',
		flags: 'g'
	}

	const replacement = (_wholeMatch: string, match: string, left: string, right: string): string => {
		match = decodeCodeEntities(match)

		const lang = (left.match(/class="([^ "]+)/) || [])[1]

		if (left.includes(CLASS_ATTR)) {
			const attrIndex = left.indexOf(CLASS_ATTR) + CLASS_ATTR.length
			left = left.slice(0, attrIndex) + 'hljs ' + left.slice(attrIndex)
		} else {
			left = left.slice(0, -1) + ' class="hljs">'
		}

		if (lang && hljs.getLanguage(lang)) {
			return left + hljs.highlight(match, { language: lang }).value + right
		}

		return left + hljs.highlightAuto(match, AUTO_DETECT_NAMES).value + right
	}

	return {
		type: 'output',
		filter: (text: string): string => {
			return helper.replaceRecursiveRegExp(text, replacement, params.left, params.right, params.flags)
		}
	}
}
