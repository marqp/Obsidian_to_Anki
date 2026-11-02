# Obsidian_to_Anki MCP bridge

Lets an AI agent (Gemini CLI, Claude Code, …) sync your notes to Anki **without the
Obsidian CLI** — useful when Obsidian is installed through Nix or any other way that
leaves `obsidian` off the `PATH`.

It is one dependency-free file, [`obsidian-anki-mcp.mjs`](./obsidian-anki-mcp.mjs), that
speaks MCP over stdio and forwards each tool call to the plugin's local HTTP API.
Requires Node 18+. Nothing to install.

## 1. Enable the API in the plugin

Obsidian → Settings → Obsidian_to_Anki → **Local API** (off by default).

- It listens on `127.0.0.1` only (default port `27180`, configurable).
- Enabling it generates **Local API Token**. Copy it.
- Obsidian and Anki must both be running when the agent calls a tool.

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
| `anki_status` | no | Is the plugin API reachable, is Anki/AnkiConnect ready |
| `anki_dry_run` `{path?}` | no | Preview adds/updates/deletes for the vault or one file |
| `anki_scan_file` `{path}` | **yes** | Sync one file (vault-relative path) |
| `anki_scan_vault` | **yes** | Sync every changed file |

The write tools create/update/delete Anki notes and stamp `<!--ID: …-->` comments into the
Markdown files. Scans started through the API skip **Confirm Before Sync**, so an agent
should call `anki_dry_run` first and show you the result.

## HTTP API (what the bridge calls)

Every request needs `Authorization: Bearer <token>` and a loopback `Host` header.

| Route | Body | Notes |
|---|---|---|
| `GET /status` | — | `{apiVersion, anki: {status, message, version}}` |
| `POST /scan` | — | `ScanReport` |
| `POST /scan-file` | `{"path": "Notes/a.md"}` | `404` if not a file in the vault |
| `POST /dry-run` | `{"path"?: "…"}` | read-only `ScanReport` with `details` |

`ScanReport`: `outcome` (`completed`, `nothing-to-sync`, `cancelled`, `aborted`, `busy`,
`awaiting-confirmation`), `filesChanged`, `filesTotal`, `added`, `updated`, `deleted`,
`converted`, `issues[]`. `busy` → HTTP 409, Anki unavailable → 503.

You can use it without MCP:

```sh
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:27180/status
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:27180/dry-run
```
