import { describe, it, expect } from 'vitest'
import { canonicalHtml, htmlToMarkdown, protectLineStarts } from '../../src/html-to-markdown'
import { FormatConverter } from '../../src/format'

const md = (html: string): string => htmlToMarkdown(html).markdown

/** The real renderer, with what Obsidian's cache holds for the embeds in the text. */
function render(markdown: string, cloze = false): string {
	const embeds = Array.from(markdown.matchAll(/!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g), (match) => ({
		original: match[0],
		link: match[1],
		displayText: match[2] ?? match[1]
	}))
	return new FormatConverter({ embeds } as never, 'V').format(markdown, cloze, cloze)
}

describe('htmlToMarkdown', () => {
	it.each([
		['plain text', 'Qual o exame?', 'Qual o exame?'],
		['line break', 'a<br>b', 'a\nb'],
		['blank line', 'a<br><br>b', 'a\n\nb'],
		['divs as lines', '<div>a</div><div>b</div>', 'a\nb'],
		['empty div as a blank line', '<div>a</div><div><br></div><div>b</div>', 'a\n\nb'],
		['bold and italic', '<b>a</b> <strong>b</strong> <i>c</i> <em>d</em>', '**a** **b** *c* *d*'],
		['space stays outside the marker', '<b>a </b>b', '**a** b'],
		['bold from css', '<span style="font-weight: bold;">a</span>', '**a**'],
		[
			'nested css switches bold off',
			'<span style="font-weight:600">a <span style="font-weight:400">b</span></span>',
			'**a** b'
		],
		[
			'underline, sub and sup stay as tags',
			'<u>a</u> H<sub>2</sub>O x<sup>2</sup>',
			'<u>a</u> H<sub>2</sub>O x<sup>2</sup>'
		],
		['image', '<img src="a.png">', '![[a.png]]'],
		['image width', '<img src="a.png" width="300">', '![[a.png|300]]'],
		['external image', '<img src="https://x.org/a.png">', '![](https://x.org/a.png)'],
		['list', 'x<ul><li>a</li><li>b</li></ul>y', 'x\n\n- a\n- b\n\ny'],
		['list item wrapping a div', '<ul><li><div>a</div></li></ul>', '- a'],
		['ordered list', '<ol><li>a</li></ol>', '1. a'],
		['nested list', '<ul><li>a<ul><li>b</li></ul></li></ul>', '- a\n    - b'],
		['break inside a list item', '<ul><li>a<br>b</li></ul>', '- a<br>b'],
		['cloze', 'O {{c1::fígado::órgão}} e {{c2::rim}}', 'O {{c1::fígado::órgão}} e {{c2::rim}}'],
		['math', 'x \\(a &lt; b\\) y', 'x $a < b$ y'],
		['link', '<a href="https://x.org">site</a>', '[site](https://x.org)'],
		['non-breaking space', 'a&nbsp;b', 'a b']
	])('%s', (_name, html, expected) => {
		expect(md(html)).toBe(expected)
	})

	it.each([
		['asterisk', '2 * 3', '2 \\* 3'],
		['underscore at a word edge', '_a_ b_c', '\\_a\\_ b_c'],
		['backtick', 'a`b', 'a\\`b'],
		['less than', 'a &lt; b', 'a &lt; b'],
		['ampersand', 'a &amp; b', 'a &amp; b'],
		['hash that the tag pass would take', 'nota #1', 'nota &#35;1'],
		['dollar that would open math', 'R$ 10 e R$ 20', 'R&#36; 10 e R&#36; 20'],
		['single brace that would become a cloze', 'a {b} c', 'a &#123;b&#125; c'],
		['line starting a list', '- a', '\\- a'],
		['line starting a numbered list', '1. a', '1\\. a'],
		['line starting a quote', '&gt; a', '\\> a']
	])('escapes a %s', (_name, html, expected) => {
		expect(md(html)).toBe(expected)
	})

	it('names tags that have no Markdown form', () => {
		expect(htmlToMarkdown('<table><tr><td>a</td></tr></table>').unsupported.sort()).toEqual(['table', 'td', 'tr'])
		expect(htmlToMarkdown('<div><span>a</span></div>').unsupported).toEqual([])
	})
})

describe('round trip through the real renderer', () => {
	it.each([
		['Qual o exame?<br>Ultrassom'],
		['<div>a</div><div><br></div><div>b</div>'],
		['<b>a</b>c <i>d</i> <u>e</u> H<sub>2</sub>O'],
		['<b>a</b><i>b</i>'],
		['<b>a<br>b</b>'],
		['x<ul><li>a</li><li><b>b</b>: c</li></ul>y'],
		['<ol><li><div><b>a:</b> b</div><ul><li>c</li></ul></li><li>d</li></ol>'],
		['2 * 3 * 4 _a_ a_b `c` &lt;d&gt; e &amp; f'],
		['nota #1 e #2'],
		['R$ 10 e R$ 20'],
		['- a<br>1. b<br>&gt; c<br># d'],
		['<img src="a.png"><br><img src="b c.jpg" width="300" alt="x">'],
		['<img src="https://x.org/a_b.png">'],
		['veja https://x.org/a_b e www.x.org'],
		['x \\(a &lt; b\\) y']
	])('keeps %s', (html) => {
		expect(canonicalHtml(render(md(html)))).toBe(canonicalHtml(html))
	})

	it('keeps clozes, in a note rendered as Cloze', () => {
		const html = 'O {{c1::<b>fígado</b>::órgão}} a {b} {{c2::rim}}<br>{{c3::x}}'

		expect(canonicalHtml(render(md(html), true))).toBe(canonicalHtml(html))
	})
})

describe('canonicalHtml', () => {
	it.each([
		['entity and space forms', 'a&nbsp;b', 'a  b'],
		['bold tags', '<b>a</b>', '<strong>a</strong>'],
		['spaces around a marker', '<b>a </b>b', '<b>a</b> b'],
		['split markers', '<b>a</b><b>b</b>', '<b>ab</b>'],
		['image attributes', '<img src="a.png" width="3">', '<img src="a.png" alt="a.png" />'],
		['paragraphs and blank lines', 'a<br><br>b', '<p>a</p>\n<p>b</p>'],
		['divs and breaks', '<div>a</div><div>b</div>', 'a<br />\nb'],
		['a third blank line', 'a<br><br><br>b', 'a<br><br>b'],
		['list markup spacing', '<ul>\n<li>a</li>\n</ul>', '<ul><li><div>a</div></li></ul>'],
		['a bare URL and its link', 'https://x.org', '<a href="https://x.org">https://x.org</a>']
	])('treats %s as the same', (_name, a, b) => {
		expect(canonicalHtml(a)).toBe(canonicalHtml(b))
	})

	it.each([
		['a word', 'a b', 'a c'],
		['bold', '<b>a</b>', 'a'],
		['bold switched off', '<b>a</b> b', '<b>a b</b>'],
		['which word is bold', '<b>a</b> b', 'a <b>b</b>'],
		['underline', '<u>a</u>', 'a'],
		['an image', '<img src="a.png">', ''],
		['which image', '<img src="a.png">', '<img src="b.png">'],
		['a line break', 'a<br>b', 'a b'],
		['a list', '<ul><li>a</li></ul>', 'a'],
		['the list kind', '<ul><li>a</li></ul>', '<ol><li>a</li></ol>'],
		['a link target', '<a href="https://x.org">a</a>', '<a href="https://y.org">a</a>'],
		['a cloze number', '{{c1::a}}', '{{c2::a}}']
	])('tells apart %s', (_name, a, b) => {
		expect(canonicalHtml(a)).not.toBe(canonicalHtml(b))
	})
})

describe('protectLineStarts', () => {
	it('hides only what the block parser reads as structure', () => {
		const text = 'ENDOMETRIOSE\nBack: x\nTags: y\nnormal\nno END here'

		expect(protectLineStarts(text, ['END', 'Back:', 'Tags: '])).toBe(
			'&#69;NDOMETRIOSE\n&#66;ack: x\n&#84;ags: y\nnormal\nno END here'
		)
	})
})
