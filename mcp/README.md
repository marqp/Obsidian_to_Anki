# Obsidian_to_Anki MCP bridge

Lets an AI agent (Gemini CLI, Claude Code, …) read your Anki collection and sync your
notes to it **without the Obsidian CLI** — useful when Obsidian is installed through Nix or any other way that
leaves `obsidian` off the `PATH`.

It is one dependency-free file, [`obsidian-anki-mcp.mjs`](./obsidian-anki-mcp.mjs), that
speaks MCP over stdio and forwards each tool call to the plugin's local HTTP API.
Requires Node 18+. Nothing to install.

## 1. Enable the API in the plugin

Obsidian → Settings → Obsidian_to_Anki → **Local API** (off by default).

- It listens on `127.0.0.1` only (default port `27180`, configurable).
- Enabling it generates **Local API Token**. Copy it.
- Obsidian must be running when the agent calls a tool, and so must Anki, except for
  `anki_validate`.

## 2. Register the server

### Gemini CLI (`~/.gemini/settings.json`)

```json
{
  "mcpServers": {
    "obsidian-to-anki": {
      "command": "node",
      "args": ["/absolute/path/to/ObsidianToAnki/mcp/obsidian-anki-mcp.mjs"],
      "env": { "OBSIDIAN_ANKI_TOKEN": "<paste the token>" }
    }
  }
}
```

On Nix, if `node` is not on the `PATH` the agent sees, use
`"command": "nix", "args": ["shell", "nixpkgs#nodejs", "-c", "node", "/absolute/path/.../obsidian-anki-mcp.mjs"]`.

### Claude Code

```sh
claude mcp add obsidian-to-anki --env OBSIDIAN_ANKI_TOKEN=<token> -- node /absolute/path/to/mcp/obsidian-anki-mcp.mjs
```

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `OBSIDIAN_ANKI_TOKEN` | — (required) | Bearer token from the plugin settings |
| `OBSIDIAN_ANKI_URL` | `http://127.0.0.1:27180` | Plugin API; must be `127.0.0.1` or `localhost` so the token never leaves your machine |

## Tools

| Tool | Writes? | What it does |
|---|---|---|
| `anki_status` | no | Plugin API and Anki readiness, whether a scan is running, how the last one ended |
| `anki_get_metadata` | no | Decks, note types and fields, tags, and the plugin rules for writing cards |
| `anki_search_notes` `{query, limit?, offset?, raw?}` | no | Search the collection with Anki syntax; each note says its `sourceFile` |
| `anki_get_notes` `{ids, raw?}` | no | Read notes by ID, with scheduling state; unknown IDs go in `missing` |
| `anki_study_overview` `{deck?, days?}` | no | Due, suspended, leeches, reviews per day, counts per deck |
| `anki_difficult_cards` `{deck?, minLapses?, limit?, includeSuspended?, raw?}` | no | Cards failed most, with text, review counts and `sourceFile` |
| `anki_import_preview` | no | Plans bringing Anki-only notes into the vault, writing nothing. A note that would change on the way back stays in Anki and appears in `refused` |
| `anki_validate` `{path?, content?}` | no | Check card syntax, including unchanged files and unsaved text; works with Anki closed |
| `anki_dry_run` `{path?}` | no | Preview changes for changed files, with what differs in each note |
| `anki_scan_file` `{path}` | **yes** | Sync one file (vault-relative path) |
| `anki_scan_vault` | **yes** | Sync every changed file |

The write tools create/update/delete Anki notes and stamp `<!--ID: …-->` comments into the
Markdown files. Scans started through the API skip **Confirm Before Sync**, so an agent
should call `anki_dry_run` first and show you the result.

No tool edits a card in Anki. Markdown owns the cards, and the next sync would overwrite
the edit. The server sends the card syntax and this workflow to the agent as instructions,
and marks each tool as read-only or not so a client can approve the safe ones automatically.

Long lists are cut for the agent: at most 200 changes, keeping deletes and conversions
first, and 200 issues. `changesByKind`, `changesOmitted`, `issuesByKind` and `issuesOmitted`
say what was left out; the HTTP API returns everything.

If the plugin loaded in Obsidian is older than the bridge, `anki_status` warns about it and
new tools say so. Update the plugin and reload it.

## HTTP API (what the bridge calls)

Every request needs `Authorization: Bearer <token>` and a loopback `Host` header.

| Route | Body | Notes |
|---|---|---|
| `GET /status` | — | `{apiVersion, anki: {status, message, version}, scan: {inProgress, lastReport?}}` |
| `POST /scan` | — | `ScanReport` |
| `POST /scan-file` | `{"path": "Notes/a.md"}` | `404` if not a file in the vault |
| `POST /dry-run` | `{"path"?: "…"}` | read-only `ScanReport` with `details` |
| `POST /validate` | `{"path"?: "…", "content"?: "…"}` | `ValidationReport`; `content` up to 1 MB |
| `GET /metadata` | — | `{decks, noteTypes, tags, rules}` |
| `POST /notes/search` | `{"query": "…", "limit"?, "offset"?, "raw"?}` | `{total, offset, limit, notes}`; at most 100 per page |
| `POST /notes/get` | `{"ids": […], "raw"?}` | `{notes, missing}`; at most 100 IDs |
| `POST /study/overview` | `{"deck"?, "days"?}` | counts and reviews per day |
| `POST /study/difficult` | `{"deck"?, "minLapses"?, "limit"?, "includeSuspended"?, "raw"?}` | `{total, cards}` |
| `POST /import/preview` | `{}` | `{candidates, ready, refused, leftInAnki, files, imageCount, externalImages, cosmeticChanges, structuralErrors}` |

`ScanReport`: `outcome` (`completed`, `nothing-to-sync`, `cancelled`, `aborted`, `busy`,
`awaiting-confirmation`), `filesChanged`, `filesTotal`, `added`, `updated`, `deleted`,
`converted`, `issues[]`. `busy` → HTTP 409, Anki unavailable → 503. After a sync the counts
say what really happened: `updated` only counts notes whose content or tags differed from
Anki. For a dry-run they say what would happen, and `updated` also counts a note that would
only change deck (`deckChanged` in `details.changes`). Each entry in `issues` has `file`, `kind` and `error`,
plus `line`, `snippet` and `noteId` when it belongs to one note. See
[the list of kinds](../docs/troubleshooting.md).

`nothing-to-sync` only means no file changed since it was last scanned. Use
`anki_validate` to look for problems in files that did not change.

`ValidationReport`: `filesChecked`, `blocks`, `errors`, `warnings`, `ankiChecked`, `byKind`,
`issues[]`, each with `file`, `kind`, `severity`, `message`, and usually `line`, `snippet`,
`noteId`. If `ankiChecked` is false, Anki was closed and IDs were not checked against it.

You can use it without MCP:

```sh
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:27180/status
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:27180/dry-run
```
