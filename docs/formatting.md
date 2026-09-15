# Formatting: Markdown, math, media, links, context

> Based on the [upstream wiki](https://github.com/ObsidianToAnki/Obsidian_to_Anki/wiki)
> (© Pseudonium). Behavior unchanged in this fork.

## Markdown and HTML

Standard Markdown in fields renders as HTML in Anki. `==highlight==` becomes
`<mark>…</mark>` (outside code spans).

## Math

- Inline: `$x = 5$` → `\(x = 5\)`
- Display: `$$z = 10$$` → `\[z = 10\]`

Math spans are masked before Markdown/Cloze processing, so `{braces}` inside
math never become clozes.

## Images

- Web: `![alt](https://…/img.png)` — copied image address works.
- Local (script): `![alt](path/to/img.png)`. GIFs work.
- Local (plugin): standard embeds plus Obsidian `![[…]]` embeds.

Media uploads are lazy: files already in `Added Media` are skipped unless
forced (`-m` flag on the script, or media cache cleared in settings).

## Audio

- Plugin: Obsidian `![[record.wav]]` embeds.
- Script: `[sound:path/to/record.wav]` with a local file.

## Links

Markdown links and `[[wikilinks]]` resolve to Anki links. With `Add File Link`,
an `obsidian://open?vault=…&file=…` link is appended to the configured field
per note type (`FILE_LINK_FIELDS`; script appends to the first field only).

## Obsidian tags and context

- `Add Obsidian Tags`: `#tags` in fields become Anki tags (removed from text).
- `Add Context`: appends `path > Heading > Subheading` (note position in the
  heading tree) to the configured field per note type (`CONTEXT_FIELDS`).

Example: `Math/Functions/test.md` with note under `# Overall` → `## Subheading 2`
gives context `Math/Functions/test.md > Overall point > Subheading 2`.
