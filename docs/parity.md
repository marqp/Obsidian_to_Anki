# Checking that the vault and Anki match

A normal scan or dry-run skips files that did not change, so an empty result says
nothing about them. To compare the whole vault with Anki, run a dry-run with
`everyFile`. It writes nothing.

- Local API: `POST /dry-run` with `{"everyFile": true}`
- MCP bridge: `anki_dry_run` with `everyFile`

Add `path` to check one file. Both need the [Local API](./usage.md) turned on.

The vault and Anki match when the report shows `added`, `updated` and `deleted` at
0 and `issues` is empty.

## What it compares

| Compared | How |
|---|---|
| Notes | Blocks without an ID count as `added`, and blocks removed from a file as `deleted` |
| Fields and note type | `updated`, or a `note-type-mismatch` issue |
| Tags | `updated`; tags that differ only in case count as equal, as they do in Anki |
| Decks | `updated`, when a card sits in another deck |
| Media | The bytes of each cited file against Anki's copy: `media-differs` or `media-missing` |

Comparing media takes one request per file, so only `everyFile` does it.

## What stays outside the Markdown

These live only in Anki, so they are not differences:

- Scheduling, review history, suspended and buried cards, and flags.
- The `leech` and `marked` tags, which Anki sets during study. Scans keep them.

Sync goes one way: Markdown owns the cards. An edit made to a note in Anki stays
there until a scan processes its file, and then the scan overwrites it. The dry-run
shows such a note as `updated`. To keep the edit, copy it to the Markdown first.

## Fixing `media-differs`

`Added Media` records only names. If a file changes, or a name is reused for another
image, Anki keeps its old file and cards keep showing it. The plugin reports this and
sends nothing, because either side can be the wrong one, so **look at both images
first**. Anki's copy is in the `collection.media` folder of your profile.

**The vault's file is right.** Remove Anki's copy with `deleteMediaFile` or from the
folder, then scan any change to a file citing it. A scan sends a cited file that Anki
no longer has.

**Anki's file is right.** The name was reused, and overwriting it would lose the image.
Copy Anki's file into the vault under a new name, point the embed at that name, and
scan. Anki then holds both files, under their own names. If the old name is still
cited anywhere, handle it as above.

Disks that respect case can report a file as not in Anki when a note cites it in
another case. Fix the citation to match the name in `collection.media`.

## After changing the collection in Anki

Removing note types, converting notes and similar changes alter the collection's
schema, and the next sync with AnkiWeb must go one way in full. Decide that direction
yourself. Downloading undoes changes made only on this computer, and uploading replaces
reviews that other devices have not synced.
