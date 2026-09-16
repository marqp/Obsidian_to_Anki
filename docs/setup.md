# Setup

> Based on the [upstream wiki](https://github.com/ObsidianToAnki/Obsidian_to_Anki/wiki)
> (© Pseudonium), updated for this fork. Card syntax is unchanged.

## All users

1. Open [Anki](https://apps.ankiweb.net/) in the profile you want cards added to.
   The plugin always writes to the current profile — switch profiles in Anki to change target.
2. Install [AnkiConnect](https://git.foosoft.net/alex/anki-connect) (Anki addon code `2055492159`).

## Plugin users

3. Install [Obsidian](https://obsidian.md/).
4. Install via [BRAT](https://github.com/TfTHacker/obsidian42-brat): add
   `marqp/Obsidian_to_Anki` as a beta plugin. This fork is not in Community Plugins.
5. Enable the plugin in Settings → Community plugins.
6. In Anki: Tools → Add-ons → AnkiConnect → Config. Minimum working config:

```json
{
	"apiKey": null,
	"apiLogPath": null,
	"webBindAddress": "127.0.0.1",
	"webBindPort": 8765,
	"webCorsOriginList": ["http://localhost", "app://obsidian.md"]
}
```

7. Restart Anki. With Anki running, reload Obsidian — the plugin generates its settings on load.

You do not need Anki running to open Obsidian afterwards, only to scan.

## Verify the install

1. `curl -sf localhost:8765` must succeed (Anki + AnkiConnect up).
2. In Obsidian: command palette → `Obsidian to Anki: Dry Run` — expect
   `dry-run complete: ... would_add=N ...` on the console, no writes.
3. Run `Scan Vault` and confirm cards appear in Anki.

## Limits

- Desktop only (`isDesktopOnly: true`). No mobile support planned.
- If AnkiConnect sets `apiKey`, set the same value in `Anki API Key` (see [config](./config.md)).
