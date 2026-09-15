# Sync: IDs, updating, deleting, data file

> Based on the [upstream wiki](https://github.com/ObsidianToAnki/Obsidian_to_Anki/wiki)
> (© Pseudonium), updated for this fork (orphan deletion, `updateNote`,
> `noteIds` tracking). Markdown files are canonical — Anki follows them.

## IDs

First successful add stamps the block:

```text
START
Basic
This is a test.
Back: Test successful!
<!--ID: 1566052191670-->
END
```

`ID Comments` (on) wraps in `<!--…-->` so preview mode stays clean.
Re-scans match by ID: same ID = update in place, scheduling preserved.
Unknown ID (deleted manually in Anki) → warning `Note with id … does not exist
in Anki!`, skipped. Remove the stale ID line to re-add as new.

## Updating

Edit fields/tags in Markdown, re-scan. Field+tag updates go through one
`updateNote` call when the daemon supports it (probed per scan, legacy
`updateNoteFields`/`updateNoteTags` fallback otherwise).

Note-type change (`Basic` → `Cloze` on the same ID) only converts with
`Allow Note Type Changes` on (default off, `updateNoteModel`); Anki discards
fields absent from the new model, so dry-run first. With the toggle off you get
a warning naming both types.

## Deleting

Explicit (both engines):

```text
DELETE
ID: 123456789
```

Separate from other blocks with blank lines, or `DELETE` reads as card text.

**Orphan deletion (fork, `Delete Removed Notes`, on by default):** removing a
`START…END` block deletes its card on the next scan — no `DELETE` line needed.
Safety rules: only IDs that vanished from a file with a stored record, not
referenced by any other tracked file, not consumed by an explicit `DELETE`,
and still reported by Anki. First scans, new files, and renames only record —
never delete.

## Data file

Plugin `data.json` (script: `obsidian_to_anki_data.json`) stores:

- `Added Media`: filenames already uploaded (skip re-upload).
- `File Hashes`: per file `{ hash, mtime, size, noteIds }`. Same
  mtime+size → skip without reading; same hash → skip without parsing.
  Legacy plain-string hashes still read.
- `fields_dict`: Anki model → field names snapshot.

Deleting the data file (or `Clear File Hash Cache`) forces a full rescan;
IDs in Markdown still match, so nothing duplicates.
