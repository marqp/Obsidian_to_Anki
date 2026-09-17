# Usage

> Based on the [upstream wiki](https://github.com/ObsidianToAnki/Obsidian_to_Anki/wiki)
> (© Pseudonium), updated for this fork (dry-run, extra commands, headless CLI).

## Commands

| Command | ID | What it does |
|---|---|---|
| Scan Vault | `obsidian-to-anki-plugin:anki-scan-vault` | Scan vault (or scan dirs), add/update/delete, stamp IDs |
| Scan Current File | `obsidian-to-anki-plugin:anki-scan-file` | Same, active file only |
| Dry Run | `obsidian-to-anki-plugin:anki-dry-run` | Preview adds/updates/deletes/conversions, no writes |
| Preview Sync | `obsidian-to-anki-plugin:anki-preview-sync` | Same preview in an interactive modal; Sync writes, Cancel discards |
| View Note in Anki Browser | `obsidian-to-anki-plugin:anki-view-in-browser` | Open card under cursor in Anki browser (`guiBrowse nid:…`) |
| Edit Note in Anki | `obsidian-to-anki-plugin:anki-edit-note` | Open card under cursor for editing |

Ribbon Anki icon = Scan Vault. `Scheduling Interval` (minutes, 0 = off) auto-scans while Obsidian runs.

Notices are minimal by design: one when the scan starts, one with the result
(`Scan complete: +5 ~2 -1 (12/120 files)`). Details go to the console, which
keeps the machine-readable one-liners for agents and log scraping.

## Scan flow

1. Read files (skip unchanged by content hash, no re-read).
2. Parse blocks → add new, update edited (IDs match), delete explicit `DELETE` + orphans.
3. Stamp `<!--ID: N-->` into new blocks, write files back.
4. Console line: `[Obsidian_to_Anki] scan complete: files_changed=A/B added=N updated=N deleted=N`.

Re-running over the same files adds no duplicates: blocks with IDs become updates.

## Dry-run

`Dry Run` prints `dry-run complete: ... would_add=N would_update=N would_delete=N would_convert=N`
plus one JSON line per file. Needs Anki running (live `notesInfo`/`cardsInfo`
for the exact diff) — it is not offline. `would_update` counts notes whose
fields, tags (order-insensitive), or card decks differ.

Delete entries in the JSON carry the file that last held the ID, so UIs can
group them per file instead of showing a bare ID list.

## Preview modal

`Preview Sync` (and `Scan Vault` / `Scan Current File` when `Confirm Before Sync`
is on in settings) shows the same diff grouped per file in a modal: `Sync now`
writes to Anki, `Cancel` (or X/Escape) discards everything. Plans that only
delete get a distinct destructive title (`Delete every Anki card?`) and CTA.
`Dry Run` always stays non-interactive (Notice + console) so headless CLI flows
never hang on UI; the scheduler never opens a modal either.

Programmatic scans accept an optional control object (not exposed in the UI
yet): `onProgress({ done, total, phase })` fires at each yield boundary
(`discover` then `scan`), and `isCancelled()` returning true aborts the scan
at the next boundary with `Scan cancelled.` — nothing is committed.

## Headless (Obsidian CLI)

No protocol handler needed; the official CLI runs any command by ID:

```bash
curl -sf localhost:8765 # Anki must be up first — failures surface as Notices, not CLI errors
obsidian "vault=My Vault" command id="obsidian-to-anki-plugin:anki-scan-vault"
obsidian "vault=My Vault" command id="obsidian-to-anki-plugin:anki-dry-run"
```

The app must be running (first command auto-launches it).
