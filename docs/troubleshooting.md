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

## Script (Python)

- Won't start: run `python3 {path}/obsidian_to_anki.py` directly; needs Python 3.8+
  (`os` features from 3.6+; no Python 2).
- `pip` issues: see the [pip user guide](https://pip.pypa.io/en/stable/user_guide/).
- `Gooey` install fails: v2.5.0+ falls back to CLI automatically.
- Scheduling: Task Scheduler (Windows) or `cron` (macOS/Linux); plugin-side
  `Scheduling Interval` only runs while Obsidian is open.
