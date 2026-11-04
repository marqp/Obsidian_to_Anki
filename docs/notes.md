# Notes: blocks, fields, inline, cloze, frozen

> Based on the [upstream wiki](https://github.com/ObsidianToAnki/Obsidian_to_Anki/wiki)
> (© Pseudonium). Syntax unchanged in this fork. Custom markers need exact-line
> match — trailing spaces after `START`/`END` are tolerated by this fork.

## Block notes

```text
START
{Note Type}
{fields}
Tags: {optional, space-separated}
END
```

Example (`Basic` has fields `Front`, `Back`):

```text
START
Basic
This is a test.
Back: Test successful!
Tags: Testing
END
```

Rules:

- First field prefix may be omitted (first line = first field).
- Every other field starts on its own line with `FieldName:` prefix.
- Fields may span lines; order is free; omit unused fields.
- `Tags:` line optional; `Tags:A B` (no space) does not parse.
- Default markers: `START`/`END`, inline `STARTI`/`ENDI`, deck `TARGET DECK`,
  file tags `FILE TAGS`, delete `DELETE`, frozen `FROZEN` — all configurable in settings.

## Inline notes

One line, anywhere (lists included):

```text
STARTI [Basic] This is a test. Back: Test successful! ENDI
```

Type comes from `[brackets]` — note types containing `[`/`]` unsupported inline.
Field prefixes work the same as blocks.

## Cloze

Standard Anki syntax works everywhere: `This is a {{c1::cloze note}}`.

`CurlyCloze` (off by default) adds shorthand on note types with `Cloze` in the
name (Basic unaffected — literal `{braces}` safe there):

| Input | Output |
|---|---|
| `{cloze} {two}` | `{{c1::cloze}} {{c2::two}}` |
| `{2:cloze} {1:id}` | `{{c2::cloze}} {{c1::id}}` |
| `{2\|a} {1\|b}`, `{c1:a}` variants | same, alternate separators |

Unnumbered clozes auto-number from 1 in order. Styles mix freely.
`{...}` inside math/code spans is ignored.
`CurlyCloze - Highlights to Clozes`: `==highlight==` → `{highlight}` before processing.

Blocks without any cloze syntax on a Cloze type are skipped with a warning, not added.

## Image Occlusion

Anki's native `Image Occlusion` notes keep their masks as text, so a block can hold them:

```
START
Image Occlusion
Occlusion: {{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.05:oi=1}}
{{c2::image-occlusion:rect:left=.5:top=.6:width=.2:height=.05:oi=1}}
{{c2::image-occlusion:rect:left=.5:top=.8:width=.2:height=.05:oi=1}}
Image: ![[picture.png]]
Header: Optional question
Back Extra: Optional context
END
```

- Each number `cN` makes one card. Masks sharing a number are asked together.
- Positions are fractions of the image, from 0 to 1. `oi=1` hides every mask while
  asking one; without it, only the mask being asked is hidden.
- Shapes are `rect` (`left`, `top`, `width`, `height`), `ellipse` (`left`, `top`, `rx`,
  `ry`) and `polygon` (`points=x,y x,y x,y`). A note with a mask Anki could not draw is
  not sent.
- Removing a number leaves its card empty in Anki, with its reviews, until
  `Empty Cards` removes it. The scan reports it as `cloze-card-emptied`.

The Markdown owns the masks, so one adjusted in Anki's editor is replaced the next time
its file syncs, and the scan reports it as `occlusion-masks-replaced`. To keep it, copy
it to the file first with `POST /occlusion/pull` or the MCP tool `anki_occlusion_pull`:
without `apply` they list the notes whose masks differ, and with `apply` and `noteIds`
they rewrite the `Occlusion` field of those blocks. A difference can also be an edit made
in the file, so look at the list before applying. Nothing changes in Anki until the next
scan, and other fields are left as they are.

## Frozen fields

Append shared content to every note of a type in the file:

```text
FROZEN - Question with context:
Context: What is the country's capital?
```

One block per note type; separate from other content with blank lines.

## Limits

- Custom note types supported, including user-defined. Unknown type → warning, skipped.
- `START…END` inside fenced code blocks still parses (deliberate, both sides).
- Regexp custom styles: off by default, see [regex](./regex.md).
