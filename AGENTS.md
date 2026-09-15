# AGENTS.md

Canonical contributor guide for AI agents and humans working on this repo.
`CLAUDE.md` is a pointer to this file — edit here, not there.

Actively developed community fork of `ObsidianToAnki/Obsidian_to_Anki` (upstream stalled
since Feb 2024). Same plugin ID (`obsidian-to-anki-plugin`), drop-in replacement
via BRAT. Fork remote: `marqp/Obsidian_to_Anki`. Card syntax stays upstream-compatible;
behavior intentionally diverged (orphan deletion, updateNote, dry-run — see README
[Fork additions]).

## Stack

- **pnpm 11.21 only** (`packageManager` pinned). No `package-lock.json`. `pnpm-workspace.yaml`
  holds `allowBuilds` and the Stryker `patchedDependencies` entry (required — without it
  `pnpm install` silently skips the vitest-runner patch and mutation scores don't reproduce).
- **Node 22**, **TypeScript `strict: true`** (`tsconfig.json` includes only `main.ts` + `src/`).
- **Vitest 5** unit/regression tests + **v8 coverage gate** (70% lines/functions over
  `src/{scan-optimizations,constants,note,setting-to-data,format,file}.ts`), enforced by `pnpm test`.
- **ESLint 9 flat** (`no-explicit-any: error`) + **Prettier** (`useTabs: true`).
- **StrykerJS** mutation testing, nightly + `src/**` PRs (`mutation.yml`), break threshold 60.
- **Rollup 2.x** still bundles `main.ts` → `main.js` (esbuild migration is parking lot).
- E2E: **WebdriverIO + Docker** (Anki 2.1.60 + Obsidian 1.5.3 images). Python suite for the CLI script.
- **Python CLI** (`obsidian_to_anki.py`, standalone): surgical parity with the TS engine
  (stat fast-path, `START[ ]*` blocks, linear `string_insert`). Fast unit suite in
  `tests/py-unit/` (stdlib + pytest only; third-party imports stubbed in `conftest.py`).

## Obsidian CLI workflow (manual, agent-friendly)

The plugin needs no protocol handler: the official `obsidian` CLI can execute any
registered command by ID (confirm prefix with `obsidian commands filter=anki`).

```bash
obsidian "vault=My Vault" command id="obsidian-to-anki-plugin:anki-scan-vault"
```

- The app must be running (first command auto-launches it); Anki + AnkiConnect must be up —
  pre-check with `curl -sf localhost:8765` because scan failures surface as Notices, not CLI errors.
  This applies to dry-run too: it needs live `notesInfo`/`cardsInfo` for the exact diff, so it is
  not an offline command.
- Every scan ends with a machine-readable line on the app console for agents/log scraping:
  `[Obsidian_to_Anki] scan complete: files_changed=2/120 added=5 updated=1 deleted=0`.
- Dry-run preview (no writes): `obsidian "vault=My Vault" command id="obsidian-to-anki-plugin:anki-dry-run"`
  emits `[Obsidian_to_Anki] dry-run complete: ... would_add=5 would_update=1 would_delete=0 would_convert=1`
  plus one JSON line with per-file changes. `would_update` counts notes whose fields, tags
  (order-insensitive) or card decks differ — it mirrors the real scan's semantics.
  New plugin features (orphan deletion, dry-run, auto-launch, note-type conversion) are
  user-facing behavior documented in README [Fork additions]; keep both docs in sync
  when behavior changes.

## Anki availability (fail-fast, desktop-only)

- Scans and dry-runs classify the endpoint via `probeAnkiStatus()` (`ready`, `needs-key`,
  `denied-origin`, `closed`, `starting-or-busy`, `busy-port`) and log
  `[Obsidian_to_Anki] anki unavailable: <reason>` before aborting. No long polling anywhere.
- Opt-in "Auto-launch Anki" fires one detached spawn (resolved per-platform in
  `resolveAnkiLaunchTarget`), waits 2s, re-probes once, then aborts with "run the scan again".
  Default off; desktop-only (`isDesktopOnly: true` — no mobile plans).
- `child_process`/`fs` are the only Node natives allowed, and only in `src/anki-launch.ts`
  (kept in Rollup `external`); everything else must stay renderer-safe.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm run dev        # rollup watch
pnpm run build      # main.ts → main.js (gitignored artifact)
pnpm test           # vitest + coverage gate (default gate)
pnpm run test:unit  # vitest without coverage (fast loop)
pnpm run lint       # 0 errors; the 2 no-non-null-assertion warnings in note.ts are known
pnpm run format:check
pnpm run test:mutation  # ~30s, needs the pnpm patch applied
pnpm run test:e2e   # docker + wdio + pytest (heavy, needs Anki/Obsidian images)
pnpm exec tsc --noEmit
```

CI (`ci.yml`, pnpm): tsc → lint → format:check → test → build. E2E (`test-e2e.yml`) runs
with `sudo env "PATH=$PATH"` so pnpm is visible under sudo.

## Architecture boundaries (do not break)

- **`obsidian` is types-only.** Unit tests alias it to `tests/mocks/obsidian.ts`
  (`vitest.config.mjs`). Never import Obsidian runtime APIs in code covered by unit tests.
- **Anki transport is injected.** Production uses `ObsidianRequestUrlTransport`
  (`requestUrl`); tests use `FetchTransport` via `setTransport()`. Never reintroduce `XMLHttpRequest`.
- **`FileHashes` accepts legacy `string` entries.** `getStoredHash`/`isStatUnchanged` handle both
  shapes — new writes are always `{ hash, mtime, size, noteIds }`. `noteIds` powers orphan
  deletion ("Delete Removed Notes", on by default): a note is only deleted when its ID vanished
  from a file that had a stored record, no other tracked file references it, an explicit DELETE
  line didn't already consume it, and Anki still reports the ID. First scans, new files and
  renames never delete because they have no stored record.
- **`multi` response `slice(1)` is intentional.** Index 0 is the `createDeck` batch result, which
  needs no processing. The single `as unknown as Requests1Result` in `parse_requests_1` is the
  documented wire trust boundary — don't scatter more casts around it.
- **`params` is `Record<string, unknown>`.** Narrow with `Array.isArray`, never `as any`.
- **Late AnkiConnect actions are gated by `apiReflect`, not `version`.** `updateNote`/`updateNoteModel`
  shipped while the API version stayed frozen at 6; `detectSupportedActions()` probes once per scan
  and callers fall back to the legacy `updateNoteFields`/`updateNoteTags` path when unsupported.
  Note-type conversion (`updateNoteModel`) is opt-in via "Allow Note Type Changes" — Anki silently
  discards fields absent from the new model.
- **No parser shielding on primary scans (deliberate NO-GO, spike 2026-09).** A `START...END`
  block inside a fenced code block still parses as a card — fixing that would require span
  filtering in `scanPattern` + symmetric filtering in `getNoteIdsInFile` + a new mechanism in
  the Python CLI, for a didactic edge case no fixture covers. Measured span-build cost was
  negligible (~0.12ms/file), so cost was not the blocker — regression surface was. The one
  exception: `getNoteIdsInFile` ignores IDs inside fenced code blocks, so a doc example like
  ` ```<!--ID: 999-->``` ` can never shield a phantom note from orphan deletion. Do not
  re-propose primary-scan shielding without re-running the spike matrix (fence-in-card,
  card-in-fence, unclosed fence, inline `::`, E2E fixture audit, Python estimate).

## tests/ map (generated vs. source)

- **Fixtures (commit):** `tests/defaults/` (vault, config, suites, spec template), `tests/specs/`
  (`ng_` files only — everything else there is generated), `tests/unit/`, `tests/anki/`
  (E2E validators of the `.anki2` DB, `scope="module"` fixtures — read-only, never write),
  `tests/py-unit/` (fast CLI-script unit tests, no Anki/Docker), `tests/mocks/`.
- **Generated at runtime (never commit, gitignored):** `tests/test_config/`, `tests/test_vault/`,
  `tests/specs_gen/`, `tests/test_outputs/`. Created by `prepare-wdio.sh` / `wdio.conf.ts`.
- `wdio.conf.ts` is excluded from `tsc` and ESLint. Python E2E pins live in `requirements-dev.txt`
  (`anki` stays range-pinned: it must track the Anki desktop version in the `Dockerfile`).

## Contribution rules

- Zero `any`, zero `eslint-disable`, zero `!` in `src/` (2 pre-existing `!` in `RegexNote` are
  warn-level and documented — don't add more).
- No `for..in` over arrays. No shared mutable module state except the `activeTransport` singleton.
- Settings UI must not mutate `settings` on read (no `dict[path] = ""` side effects on open).
- Coverage must not drop below the gate; surviving Stryker mutants become a new test or a written
  justification — never a silent ignore.
- Keep commits sliced (tooling → strict/typing → tests → features). Never mix a Prettier reformat
  with functional changes in one commit.
- **Do not move the root `.py` files.** `obsidian_to_anki.py` resolves its config/data paths
  relative to `__file__`, existing users auto-update from release assets, and `tests/anki`
  depends on the layout. Same for `obsidian_to_anki_config.ini` (sample) and
  `obsidian_to_anki_data.json` (empty seed) — tracked on purpose.
- `root/` is the Docker `COPY` overlay; `Images/` has external hotlinks; `versions.json` is
  required by the Obsidian release flow. Leave all three alone.

## Gotchas

- AnkiConnect lives at `127.0.0.1:8765`; E2E needs it plus the Docker images.
- `getActiveFile()` returns `TFile | null` — `scanVault` accepts null.
- `tests/mocks/obsidian.ts` also shims `document` for Node — extend it, don't work around it.
- Release flow (`obsidian-release.yml`): tag → build → draft GitHub release with
  `main.js`, `manifest.json`, `styles.css`. Keep `package.json` and `manifest.json` versions in sync.
