# Troubleshooting

> Based on the [upstream wiki](https://github.com/ObsidianToAnki/Obsidian_to_Anki/wiki)
> (© Pseudonium), rewritten symptom-first and updated for this fork's endpoint
> classification. Open the console (`Ctrl+Shift+I` / `Cmd+Shift+I`) — the plugin
> logs there, not in popups.

## Anki / connection

| Symptom | Cause | Fix |
|---|---|---|
| `anki unavailable: closed` | Anki not running | Open Anki, or enable `Auto-launch Anki` and re-run |
| `needs-key` | AnkiConnect has `apiKey` | Set same value in `Anki API Key` |
| `denied-origin` | CORS origin missing | Add `app://obsidian.md` to `webCorsOriginList`, restart Anki |
| `busy-port` / `starting-or-busy` | Port held by another process / Anki busy | Free `:8765` or wait and re-run |
| Scan silently does nothing via CLI | Notice shown in app, CLI exits 0 | Pre-check `curl -sf localhost:8765`; read the app console |

Dry-run needs Anki up too (live `notesInfo`/`cardsInfo` for the diff).

Since the plugin now names the exact status in its Notices (instead of a generic
"Couldn't connect"), the table above is also what you will see on screen. Notices that
mention a *problem* after a sync (`N problem(s) during sync`) list the first few failing
files; the full list is in the console as `scan issues: [...]`.

## Problems listed after a scan

Each entry in `issues` names its file and, when it belongs to one note, its line
and the start of its text. A dry-run lists the ones the parser finds.

| `kind` | Meaning | Tried again next scan |
|---|---|---|
| `cloze-without-deletions` | Cloze note with no deletion; it was not sent | No, fix the note |
| `unknown-note-type` | Note type not in the plugin's table; it was not sent | No, fix the note or refresh the table |
| `stale-note-id` | The ID no longer exists in Anki; the block was not synced | No, remove the ID line to recreate it |
| `duplicate-note-id` | Two blocks in one file share an ID and overwrite one note | No, remove one ID line |
| `note-type-mismatch` | Type differs from Anki and cannot be converted | No, enable `Allow Note Type Changes` |
| `media-missing` | Embedded file not found in the vault | No |
| `ankiweb-sync` | Local sync worked, the AnkiWeb sync did not | No |
| `add-note`, `add-notes`, `add-notes-file` | Anki refused the new note | Yes |
| `update-note`, `delete-note`, `change-deck`, `update-tags`, `convert-note` | Anki refused the change | Yes |
| `notes-info`, `note-info-file`, `media` | A read or an upload failed | Yes |

"Tried again" means the file keeps counting as changed, so the next scan processes
it again and resends all of its notes. A problem you must fix yourself is reported
once, when the file is scanned; it does not repeat until the file changes.

## Local API / MCP

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot reach the plugin API` in the agent | Obsidian closed, or `Local API` off | Open Obsidian, enable `Local API` in the plugin settings |
| `The plugin rejected the token` | Token in the MCP env differs from the settings | Copy `Local API Token` again into `OBSIDIAN_ANKI_TOKEN` |
| `Local API could not start on port …` (Notice) | Port already in use | Change `Local API Port` |
| `Another scan is already running` (HTTP 409) | A scan/dry-run holds the guard | Wait for it, then retry |
| `File was edited during the sync; note IDs were not written` | You edited the note while the sync ran | Re-scan; if the card was duplicated, delete the duplicate in Anki |

## Cards

| Symptom | Cause | Fix |
|---|---|---|
| IDs missing on some blocks | Parse warnings in console (unknown type, cloze without `{{cN::}}`) | Fix the block; re-scan |
| `Note with id … does not exist in Anki!` | Card deleted in Anki, ID left in Markdown | Remove the ID line to re-add, or restore the card |
| `Did not recognise note type` | Typo in type line / model renamed in Anki | Fix type; `Regenerate Note Type Table` after Anki model changes |
| Cards land in `Default` despite `TARGET DECK` | Server ignores `deckName` in `addNote` (Anki 2.1.60, both engines) | Verify routing in dry-run detail; move in Anki or script `changeDeck` |
| `DELETE` added literal text | No blank line around the block | Separate with blank lines (see [sync](./sync.md)) |
| Removed block did not delete card | `Delete Removed Notes` off, or first scan (records only), or ID referenced elsewhere | Check toggle; re-scan; check other files for the ID |
| Cloze block skipped | No `{{cN::}}` in fields | Add cloze syntax or use a non-Cloze type |
| `Tags:A` ignored | Missing space after colon | `Tags: A B` |
| `Scan Directories` path silently skipped | Typo or file path instead of folder | Invalid paths get a red border in settings; scans continue with the valid ones |
