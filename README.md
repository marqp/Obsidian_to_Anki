# Obsidian_to_Anki (marqp fork) <sup>[why?](#why-this-fork)</sup>

An Obsidian plugin that keeps your flashcards in Markdown and syncs them to Anki. Your files own the cards: edit a note, scan, and Anki follows, with scheduling and review history intact. It supports [Obsidian](https://obsidian.md/) Markdown, **custom syntax for flashcards**, native Image Occlusion, and AI agents through a local API and MCP.

```markdown
TARGET DECK: Medicine
FILE TAGS: Cardiology

START
Basic
Front: Which valve closes first in systole?
Back: The mitral valve.
END

START
Cloze
Text: Target blood pressure is below {{c1::130/80}} mmHg.
Extra: Use the lowest tolerated value otherwise.
END
```

On the first scan, the plugin creates the notes and stamps an `<!--ID: …-->` line into each block. That ID links the block to its note from then on, so don't write or copy one by hand.

## Why this fork?

Upstream (`ObsidianToAnki/Obsidian_to_Anki`) has not been updated since Feb 2024, with open PRs and issues piling up. This fork started by merging those stalled PRs and has since grown its own architecture. It keeps the plugin ID (`obsidian-to-anki-plugin`), so it is a drop-in replacement through BRAT, and card syntax (`START`/`END`, inline notes, custom regexps, Python CLI format) stays compatible with upstream.

- **Sync you can trust**: orphan deletion, dry-run preview, per-note scan reports, and a check that compares the whole vault with Anki.
- **Your whole collection in Markdown**: import notes that exist only in Anki, keeping their IDs and scheduling.
- **Built for agents**: a loopback API and an MCP bridge to validate, preview and sync cards, and to read study data.
- **Faster engine**: incremental scans, memoized formatting and linear ID writes (measured: up to 5.4x on large files, see `pnpm run test:bench`).
- **Modern UX, minimal UI**: tabbed settings, consolidated progress notices, cooperative scan cancel, connection probing with auto-launch.
- **Maintained toolchain**: esbuild, strict TypeScript, Vitest with mutation testing, and a parity harness against pinned upstream.

## Setup

The plugin runs on desktop only, and full instructions are in the [docs](./docs/index.md).

1. Start [Anki](https://apps.ankiweb.net/), open your profile, and install [AnkiConnect](https://git.foosoft.net/alex/anki-connect).
2. In Anki, go to Tools → Add-ons → AnkiConnect → Config, and set:
   <pre>
   {
       "apiKey": null,
       "apiLogPath": null,
       "webBindAddress": "127.0.0.1",
       "webBindPort": 8765,
       "webCorsOriginList": [
           "http://localhost",
           "app://obsidian.md"
       ]
   }
   </pre>
3. Restart Anki.
4. Install the plugin through [BRAT](https://github.com/TfTHacker/obsidian42-brat) by adding `marqp/Obsidian_to_Anki` as a beta plugin. This fork is not listed in Community Plugins.
5. With Anki running, enable the plugin in Settings → Community plugins. This generates its settings.

To sync, use the Anki icon on the ribbon or the `Scan Vault` command. Anki must be running for a scan, unless you turn on `Auto-launch Anki`.

## Everyday workflow

1. Write or edit cards in Markdown.
2. Run `Dry Run` or `Preview Sync` to see what would change.
3. Run `Scan Vault` or `Scan Current File`.
4. Read any problems in the scan report. Each one names its file and, when it belongs to one note, its line.

To delete a card, remove its block. To change a card, edit its block, not the note in Anki: the next scan of that file overwrites edits made in Anki. Scheduling, review history, suspensions and the `leech` and `marked` tags stay in Anki, and scans leave them alone.

## Features

These work as in upstream; see the [docs](./docs/index.md) for details.

- **Custom note types**, not just Anki's built-in ones.
- **Scan directories and ignores**: scan the whole vault or chosen directories, and skip files with [glob syntax](https://en.wikipedia.org/wiki/Glob_(programming)#Syntax), such as `**/*.excalidraw.md`, `Template/**` or `**/private/**`.
- **Decks and tags per file**: use `TARGET DECK` and `FILE TAGS`, with several target decks in one file if you need them. Cards go to the nearest `TARGET DECK` above them, and a `TARGET DECK` in YAML frontmatter locks the whole file to that deck.
- **Rich content**: Markdown, math, embedded images, GIFs and audio.
- **Compact notes**: inline notes, easy cloze syntax and frozen fields.
- **Obsidian integration**: links to the source file, plus full link and image embed support.

### Custom syntax

Regular expressions can **turn your own note style into cards**. All custom syntax is off by default: enable it per note type by pasting a regexp into `CUSTOM_REGEXPS` in the settings. See the [regex docs](./docs/regex.md).

- RemNote single-line style: `This is how to use::Remnote single-line style`

  ![Remnote 1](Images/Remnote_1.png)
- Header paragraph style:
  <pre>
  # Style
  This style is suitable for having the header as the front, and the answer as the back
  </pre>

  ![Header 1](Images/Header_1.png)
- Question answer style:
  <pre>
  Q: How do you use this style?
  A: Just like this.
  </pre>

  ![Question 1](Images/Question_1.png)
- Neuracache #flashcard style:
  <pre>
  In Neuracache style, to make a flashcard you do #flashcard
  The next lines then become the back of the flashcard
  </pre>

  ![Neuracache 1](Images/Neuracache_1.png)
- Ruled style:
  <pre>
  How do you use ruled style?
  ---
  You need at least three '-' between the front and back of the card.
  </pre>

  ![Ruled 1](Images/Ruled_1.png)
- Markdown table style:
  <pre>
  | Why might this style be useful? |
  | ------ |
  | It looks nice when rendered as HTML in a markdown editor. |
  </pre>

  ![Table 2](Images/Table_2.png)
- Cloze paragraph style:
  <pre>
  The idea of {cloze paragraph style} is to be able to recognise any paragraphs that contain {cloze deletions}.
  </pre>

  ![Cloze 1](Images/Cloze_1.png)

## Fork additions

Everything above works as in upstream. This fork adds the following.

### Checking the vault against Anki

- **Dry-run preview**: the `Dry Run` command prints what a scan would add, update, delete or convert, without writing to files or Anki. It also runs headless through the [Obsidian CLI](https://help.obsidian.md/cli): `obsidian "vault=My Vault" command id="obsidian-to-anki-plugin:anki-dry-run"`.
- **Preview modal**: `Preview Sync` shows the same diff per file, with `Sync now` and `Cancel`. `Confirm Before Sync` (off by default) sends the scan commands through it too.
- **Whole-vault comparison**: a dry-run skips unchanged files, so an empty result says nothing about them. With `everyFile`, it reads every file and compares fields, tags, decks, note types and the bytes of cited media with Anki, writing nothing. See [parity.md](./docs/parity.md).
- **Scan reports**: problems come back as structured issues with the file, the line and the start of the note's text, instead of silent skips. See the [list of kinds](./docs/troubleshooting.md).

An image edited in the vault reaches Anki on the next whole-vault scan, with no note changing. If Anki's copy also changed, or the plugin has no record of what it sent, nothing is overwritten: the scan reports `media-differs`, and [parity.md](./docs/parity.md#when-an-image-changes) explains how to tell which side is right.

### Sync behavior

- **Removed blocks delete their cards**: removing a `START…END` block deletes its note on the next scan, with no `DELETE` line needed. It is tracked per file, so renames and moves between files are safe, and the first scan of a file only records IDs. Toggle: `Delete Removed Notes` (on by default).
- **Study tags survive**: scans keep the `leech` and `marked` tags that Anki sets during study.
- **Stable notes**: a note whose tags only change order keeps its modification time.
- **Note-type conversion (opt-in)**: `Allow Note Type Changes` (off by default) converts cards whose note type changed in Markdown, keeping review history. Anki discards fields absent from the new type, so preview first.
- **Media that comes back**: a file Anki no longer has is sent again the next time a scan reads a note citing it.
- **Optional AnkiWeb sync**: `Sync to AnkiWeb` (off by default) syncs after each scan.

### Importing notes from Anki

Notes that exist only in Anki can move into the vault with their note IDs, so they keep their cards and scheduling. Run `anki_import_preview` to see the plan: a note that would change on the way back stays in Anki and is listed as refused. `anki_import_apply` then copies the images and writes new files, never overwriting one. From the next scan on, Markdown owns those notes, and removing a block deletes the note. Both tools come with the [MCP bridge](./mcp/README.md).

### Image Occlusion

Anki's native `Image Occlusion` notes can live in Markdown, because their masks are text. Blocks with an image that is not in the vault, or with a mask Anki could not draw, are reported instead of sent. To keep masks adjusted in Anki, copy them back with `anki_occlusion_pull` before the next scan replaces them. See [notes.md](./docs/notes.md#image-occlusion).

### Local API and MCP for AI agents

Turn on `Local API` (off by default) to expose scans, dry-runs, offline card validation, and read-only access to your collection and study data. It listens on `127.0.0.1` only, behind a bearer token. Register the dependency-free [MCP bridge](./mcp/README.md) in Gemini CLI or Claude Code; it needs Node 18+ and works when the Obsidian CLI is not available, such as with Obsidian installed through Nix.

| Tools | What they do |
|---|---|
| `anki_status`, `anki_get_metadata` | Check readiness; list decks, note types, tags and the rules for writing cards |
| `anki_validate`, `anki_dry_run` | Check syntax, even with Anki closed; preview changes |
| `anki_scan_file`, `anki_scan_files`, `anki_scan_folder`, `anki_scan_vault` | Sync one file, a list of files, a folder, or every changed file |
| `anki_search_notes`, `anki_get_notes` | Search and read notes, each with its source file |
| `anki_study_overview`, `anki_difficult_cards` | Read due counts, leeches, reviews per day and the most-failed cards |
| `anki_import_preview`, `anki_import_apply` | Bring Anki-only notes into the vault |
| `anki_occlusion_pull` | Copy masks adjusted in Anki to the Markdown |

No tool edits a card in Anki, since the next sync would overwrite the edit. Scans started through the API skip `Confirm Before Sync`, so an agent should run `anki_dry_run` first and show you the result.

Vaults with the API on share a port by default, and a scan writes to whichever Anki profile is active. If you keep more than one, give each vault its own `Local API Port`, and check the profile before scanning.

### Anki connectivity

- **Availability detection**: scans classify the endpoint (`ready`, `needs-key`, `denied-origin`, `closed`, `starting-or-busy`, `busy-port`) and report a specific message instead of a generic connection error.
- **Auto-launch**: `Auto-launch Anki` (off by default) starts Anki when a scan finds it closed.
- **API keys**: works with AnkiConnect instances protected by `apiKey`, with a "Test AnkiConnect Connection" button in the settings.

### Commands

`Scan Vault`, `Scan Current File`, `Dry Run`, `Preview Sync`, `View Note in Anki Browser` and `Edit Note in Anki`, which jumps to the note under the cursor.

### Performance

- **Incremental scans**: files whose content hash is unchanged are skipped without re-reading.
- **Faster boot**: plugin data is read once at startup instead of once per loader.
- **Consolidated updates**: field and tag changes go through one `updateNote` call when AnkiConnect supports it, probed per scan, with a legacy fallback.
- **Single-pass text formatting**: censor and decensor masking without double regex passes.

### Plugin identity

The plugin ID stays `obsidian-to-anki-plugin` on purpose: this fork is a drop-in replacement for the upstream plugin. Same ID means the same settings (`data.json`), the same command IDs (`obsidian-to-anki-plugin:anki-scan-vault`, `anki-scan-file`, `anki-dry-run`, `anki-preview-sync`, `anki-view-in-browser`, `anki-edit-note`), and the same install slot under BRAT. Swap the remote to `marqp/Obsidian_to_Anki` and keep your vault, your `<!--ID: …-->` comments, and your Anki scheduling. Only the author (`marqp`) and the release artifacts differ.

Do not change the ID: it would orphan existing `data.json` files, break headless `obsidian … command id=…` calls, and force users to re-add every card.

## Development

This fork is maintained with `pnpm` (v11.21) and Node 22. See [AGENTS.md](./AGENTS.md) for the full contributor guide.

```bash
pnpm install --frozen-lockfile
pnpm run dev        # watch build
pnpm run build      # production bundle (main.js)
pnpm test           # unit + regression tests with coverage gate
pnpm run lint && pnpm run format:check
pnpm run test:parity # parity tests against pinned upstream
```

Test layout: `tests/unit/` (Vitest unit and regression tests) · `tests/parity/` (fork-vs-upstream parse parity harness).

Releases are built from a tag by `.github/workflows/obsidian-release.yml`, with attested artifacts. Verify a download with `gh attestation verify main.js --repo marqp/Obsidian_to_Anki`.
