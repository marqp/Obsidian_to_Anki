# Decks and tags

> Based on the [upstream wiki](https://github.com/ObsidianToAnki/Obsidian_to_Anki/wiki)
> (© Pseudonium), updated for this fork (multi-deck routing, folder rules,
> Unicode tags, server-side deck note).

## Target deck

Anywhere in the file, either form (defaults shown):

```text
TARGET DECK
Mathematics
```

```text
TARGET DECK: Mathematics
```

Without any `TARGET DECK`, cards go to the `Deck` default (`Default`).

**Fork behavior (differs from upstream):** cards use the nearest `TARGET DECK`
line *above* them, so one file can feed multiple decks. Upstream reads only the
first match per file. If the line sits in YAML frontmatter (between the first
two `---`), it locks the whole file to that deck.

**Server-side note:** Anki 2.1.60 + AnkiConnect ignore `deckName` in `addNote`
even after `createDeck` (verified via direct API calls — cards land in
`Default` on both engines). Deck routing is verified at parse level (dry-run
detail); if cards land in the wrong deck, the cause is the server, not the plugin.

## Tags

Per-note (optional `Tags:` line, space after colon required):

```text
START
Basic
Front: Q
Back: A
Tags: Tag1 Tag2
END
```

Per-file (every card in the file; no `Tags:` prefix):

```text
FILE TAGS: Maths School Physics
```

or the two-line form. Same spacing rule: space-separated, no prefix.

`#hashtags` in fields become Anki tags only with `Add Obsidian Tags` on
(default off) — otherwise they stay literal text. Unicode tags supported
(`café`, `日本語`).

## Folder rules (plugin only)

- **Folder deck:** deck for the folder; blank defers to parent, then global default.
- **Folder tags:** space-separated, inherited by subfolders.

Precedence for a card: nearest `TARGET DECK` above it → folder deck → global `Deck`.
Tags accumulate: per-note + file + folder + global `Tag` (`Obsidian_to_Anki`).
