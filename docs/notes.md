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
