# Config reference

> Based on the [upstream wiki](https://github.com/ObsidianToAnki/Obsidian_to_Anki/wiki)
> (© Pseudonium), updated for every setting this fork added. Defaults shown are
> the plugin's (`main.ts` `getDefaultSettings`); script equivalents live in
> `obsidian_to_anki_config.ini` (`False`/`True`, `CurlyCloze = False` there).

Settings open under `Obsidian_to_Anki settings (marqp fork)` with four tabs:
**General** (defaults), **Notes** (note-type table + syntax), **Folders**
(folder rules + ignore globs), **Actions** (regenerate, test, cache clears).
The active tab is kept in memory only — switching vaults or reopening settings
starts on General, and settings are never written on read.

## Defaults

| Setting | Default | Effect |
|---|---|---|
| `Scan Directories` | _(empty = whole vault)_ | One path per line; subfolders included |
| `Tag` | `Obsidian_to_Anki` | Added to every card |
| `Deck` | `Default` | Fallback when no `TARGET DECK` / folder deck applies |
| `Scheduling Interval` | `0` (off) | Auto-scan every N minutes while Obsidian runs |
| `Add File Link` | off | Append `obsidian://` file link to the configured field per note type |
| `Add Context` | off | Append `path > headings` to the configured field per note type |
| `CurlyCloze` | off | `{…}` → `{{cN::…}}` on note types with `Cloze` in the name |
| `CurlyCloze - Highlights to Clozes` | off | `==x==` → `{x}` before CurlyCloze |
| `ID Comments` | on | Wrap IDs in `<!--…-->` |
| `Add Obsidian Tags` | off | `#tags` in fields become Anki tags |
| `Anki API Key` | _(empty)_ | Only if AnkiConnect sets `apiKey`; plaintext, localhost only |
| `Sync to AnkiWeb` | off | `sync` after each scan (needs AnkiWeb login in desktop Anki) |
| `Delete Removed Notes` | **on** | Orphan deletion (see [sync](./sync.md)) |
| `Allow Note Type Changes` | off | `updateNoteModel` conversion; target-model-missing fields discarded by Anki |
| `Auto-launch Anki` | off | One detached spawn if Anki closed, 2 s wait, re-probe once (desktop only) |

## Syntax

`Begin Note` (`START`), `End Note` (`END`), `Begin Inline Note` (`STARTI`),
`End Inline Note` (`ENDI`), `Target Deck Line` (`TARGET DECK`, also
`TARGET DECK: X`), `File Tags Line` (`FILE TAGS`, also `FILE TAGS: x`),
`Delete Note Line` (`DELETE`), `Frozen Fields Line` (`FROZEN`).
Markers match whole lines; this fork tolerates trailing spaces after
`START`/`END`. See [notes](./notes.md).

## Tables and folders

- Note-type table: fields, file-link field, context field per model
  (`Regenerate Note Type Table` re-reads `modelFieldNames` after adding models in Anki).
- `CUSTOM_REGEXPS`: one regexp per note type (see [regex](./regex.md)).
- `FOLDER_DECKS` / `FOLDER_TAGS`: per-folder deck and inherited tags (plugin only).
- `IGNORED_FILE_GLOBS` (default `**/*.excalidraw.md`): one glob per line
  (`Template/**`, `**/private/**`, `[Pp]rivate*/**`; test at globster.xyz).

## Buttons

`Test AnkiConnect Connection` (endpoint classification),
`Clear Media Cache` (force re-upload), `Clear File Hash Cache` (force full rescan).
