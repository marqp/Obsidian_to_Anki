# Custom regexps

> Based on the [upstream wiki](https://github.com/ObsidianToAnki/Obsidian_to_Anki/wiki)
> (© Pseudonium). All custom syntax is off by default in this fork too.

## Rules

- One regexp per note type, pasted into `CUSTOM_REGEXPS` (plugin settings) or config file (script).
- Capture groups map to fields in order: 1st group → 1st field, 2nd → 2nd, etc.
  Count must match the note type's field count.
- Compiled with the multiline flag: `^` matches line starts.
- Matches inside another match (different note type) are ignored.
- Paragraph regexps: end alternation with `(?:^.{1,3}$|^.{4}(?<!<!--).*))`
  so the `<!--` of an ID comment is never swallowed.
- Tags: append `Tags: a b` on the same line (single-line styles) or the next
  line (paragraph styles). `FILE TAGS` / folder tags also apply.

## Built-in templates

### RemNote single-line — `^(.*[^\n:]{1}):{2}([^\n:]{1}.*)`

```text
This is how to use::Remnote single-line style
You can have::multiple notes in the same file
```

### Header paragraph

Front = `# Header`, back = following paragraph:

```text
# Style
This style is suitable for having the header as the front, and the answer as the back
```

### Question / answer

```text
Q: How do you use this style?
A: Just like this.
```

### Neuracache `#flashcard`

```text
In Neuracache style, to make a flashcard you do #flashcard
The next lines then become the back of the flashcard
```

### Ruled

Front/back split by 3+ dashes:

```text
How do you use ruled style?
---
You need at least three '-' between the front and back of the card.
```

### Markdown table

```text
| Why might this style be useful? |
| ------ |
| It looks nice when rendered as HTML in a markdown editor. |
```

### Cloze paragraph

```text
The idea of {cloze paragraph style} is to be able to recognise any paragraphs that contain {cloze deletions}.
```

Combines with [CurlyCloze](./notes.md#cloze).

## Deleting regexp notes

Clear the content, keep the ID line:

```text
DELETE
<!--ID: 129414201900-->
```

## Conflicts

Keep regexps non-overlapping. Default `START…END` blocks are excluded from
regexp matching automatically.
