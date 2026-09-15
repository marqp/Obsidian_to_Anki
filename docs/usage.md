# Usage

> Based on the [upstream wiki](https://github.com/ObsidianToAnki/Obsidian_to_Anki/wiki)
> (© Pseudonium), updated for this fork (dry-run, extra commands, headless CLI).

## Commands

| Command | ID | What it does |
|---|---|---|
| Scan Vault | `obsidian-to-anki-plugin:anki-scan-vault` | Scan vault (or scan dirs), add/update/delete, stamp IDs |
| Scan Current File | `obsidian-to-anki-plugin:anki-scan-file` | Same, active file only |
| Dry Run | `obsidian-to-anki-plugin:anki-dry-run` | Preview adds/updates/deletes/conversions, no writes |
| View Note in Anki Browser | `obsidian-to-anki-plugin:anki-view-in-browser` | Open card under cursor in Anki browser (`guiBrowse nid:…`) |
| Edit Note in Anki | `obsidian-to-anki-plugin:anki-edit-note` | Open card under cursor for editing |

Ribbon Anki icon = Scan Vault. `Scheduling Interval` (minutes, 0 = off) auto-scans while Obsidian runs.

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

## Headless (Obsidian CLI)

No protocol handler needed; the official CLI runs any command by ID:

```bash
curl -sf localhost:8765 # Anki must be up first — failures surface as Notices, not CLI errors
obsidian "vault=My Vault" command id="obsidian-to-anki-plugin:anki-scan-vault"
obsidian "vault=My Vault" command id="obsidian-to-anki-plugin:anki-dry-run"
```

The app must be running (first command auto-launches it).

## Python script CLI

Apart from editing the config, every operation needs Anki running.

```bash
obsidian_to_anki.py [path]   # file or folder
obsidian_to_anki.py -h       # help
obsidian_to_anki.py -c       # open config for editing (OS-dependent)
obsidian_to_anki.py -u       # refresh config after adding Anki note types
obsidian_to_anki.py -m       # force re-add all detected media (e.g. after resize)
obsidian_to_anki.py -r       # custom-regex syntax only, ignore default blocks
obsidian_to_anki.py -R       # recurse into subfolders
```

Set `GUI = False` in `obsidian_to_anki_config.ini` for CLI mode.
