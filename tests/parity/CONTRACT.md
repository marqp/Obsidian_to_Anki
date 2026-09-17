# Parity contract: fork vs upstream plugin

Pinned upstream: `upstream/master@feb3db2708559bf386412ef6f8be00753faf7775`
(see `tests/parity/config.json`; update procedure below).

## What counts as parity (observable)

For identical inputs (fixture `.md` + equivalent settings + same stubbed
Anki state), both engines must produce identical **observable** outputs:

- detected cards: deck, model, fields HTML, tags
- classification add vs edit (orphan/managed `<!--ID: N-->` markers)
- IDs stamped into the `.md` (final Markdown text identical)
- deletes via explicit `DELETE` lines
- equivalent errors/warnings (categories and counts, not exact strings)

## Explicitly out of scope

- Fork-intentional divergences (README [Fork additions]): orphan deletion,
  `updateNote` vs `updateNoteFields+Tags` (compare **end state**, not wire),
  dry-run, auto-launch, apiKey. Parity runs set all fork-only toggles OFF.
- Timings, batching order, Notices, console log formats.
- `getNoteIdsInFile`/orphans and `updateNoteModel` have no upstream
  equivalent; they are covered by the fork's own unit tests.
- Model change with conversion OFF: record what upstream does and compare;
  a divergence becomes a documented known-difference, not necessarily a bug.
- Server-side deck assignment: Anki 2.1.60 (+ AnkiConnect) ignores `deckName`
  in `addNote` even after `createDeck` — observed via direct `curl` on both
  sides (cards land in `Default`). Both engines send the correct payload, so
  deck routing is verified at parse level only (dry-run detail), not end-state.

## Warning comparison policy

Warnings are compared by category (`unknown-id`, `unknown-model`,
`cloze-skip`), not string-exact. Text-only diffs in warnings do not break
parity; parse/ID/delete diffs do, and require a fix or a written justification
appended to this file.

## Upstream triage log (release 4.0.0)

Rescue batch #694 (`Merged batch 1`, +532/−88, 22 files) was NOT merged
wholesale: the fork already contains the equivalent of 12 of its 13 items
via its own diverged architecture (`git log upstream/master..master`:
`5ed55d8`=#639, `bbf819f`=#674, `245013b`=#687, `5748587`≈#693,
`462a082`=#642, `9dceed6`≈#656, `00837f1`=#659, `7837bb7`+`67a6a41`=#617/#627,
`cea8ddb`=#618, `b8b2eb3`≈#627, multi-deck≈#691, scan-dirs≈#664). A wholesale
merge would conflict against orphan deletion / `updateNote` / dry-run /
object `FileHashes` / `EXISTING_IDS` Set. Item verdicts:

- #649 (xhr content-type, +1/−0): obsolete — transport is `requestUrl`, no XHR.
- #557 (file-link filename label): cherry-picked in 4.0.0 (`format_note_with_url`
  now renders `Obsidian - <filename>`; unit-tested in `format.test.ts`).
- #537 (HTML entities as obsidian tags): superseded — the fork's unicode
  `OBS_TAG_REGEXP` (`note.ts:15`) matches a superset including the `&#039;` case
  (the lookbehind `(?<=^|[\t ])` can never fire after `&`), while additionally
  supporting unicode and hyphens that upstream `/(?:&#\d+;)|#(\w+)/g` drops.
  Locked by unit vectors in `tests/unit/note.test.ts` ("ignores HTML entities
  while keeping unicode/hyphen tags").
- #584 (updateNoteTags + scan-current-file): superseded — the fork has
  `anki-scan-file` + `scanVaultOnce`, and goes further with consolidated
  `updateNote` (apiReflect-gated) instead of `updateNoteTags` alone.
- #429 (folder-deck/tags/custom-regex-deletion, 2023): superseded —
  `FOLDER_DECKS`/`FOLDER_TAGS` + multi-deck + per-type custom regexps exist.
- #570 (+923/−246, folder-sync + backlink): rejected — feature 1 duplicates
  folder-deck/multi-deck; feature 2 touches the diverged censor/`memoCache`/
  orphan core. Backlink-by-filename (#557) covers the navigability need.
  Backlog: full block-level backlink as an isolated future proposal.
- #673 (redesign +1738/−355, `src/ui/` + new sync commands): rejected —
  duplicates the fork's native tabs/tables/`ScanControl` UX direction (no
  framework per AGENTS.md Tailwind ban rationale), ships zero tests, commits a
  `.backup` file + `package-lock.json`, and new sync commands threaten the
  orphan-deletion/dry-run invariants. Backlog: native folder-picker only.
- #672 (LLM integration +7662/−5): rejected — out of scope (API keys,
  `src/llm/`, renderer-safe violation, desktop-only secret policy).
- Drafts #508/#444/#301 + #693-draft: watch, out of 4.0.0 scope.

## Known intentional divergences (fork features, not bugs)

These fixtures encode behavior the fork added on purpose. They fail the
structural diff by design and serve as living documentation:

- `target-deck-move`: the fork routes each card to its nearest `TARGET DECK`
  line (multi-deck per file); upstream assigns the whole file to the first
  match. Deck routing is fork behavior, covered by the fork's own E2E suite.
- `fence-doc`: a `START...END` block inside a fenced code block still parses
  as a card on both sides today (deliberate NO-GO, see AGENTS.md). If either
  side ever shields fenced code, this fixture will flag the behavior change
  for explicit triage instead of passing silently.
- `target-deck-move` and `trailing-spaces`: upstream never merged the
  community trailing-space tolerance (`5ed55d8`, rescue batch #694). The fork
  intentionally supports trailing spaces after `START`/`END` markers. This is
  syntax behavior users can hit by accident, so it is pinned as a known
  divergence rather than silently absorbed.
- `file-link-label` (upstream #557, cherry-picked in 4.0.0): the backlink the
  fork appends to `FILE_LINK_FIELDS` renders `Obsidian - <filename>` instead of
  upstream's bare `Obsidian`. Deliberate UX improvement, unit-tested in
  `tests/unit/format.test.ts`. The parity harness runs with empty
  `FILE_LINK_FIELDS`, so `format_note_with_url` is never exercised there —
  this divergence cannot break the gate by construction.
- `hljs-subset` (bundle slimming, PR-16): the fork replaced
  `showdown-highlight` with an internal extension (`src/highlight.ts`) that
  registers 24 languages plus a curated auto-detect set. Registered-language
  fences highlight byte-identically; untagged or unregistered-language fences
  may auto-detect differently (full registry could pick e.g. `x86asm`; the
  subset picks a registered language or none). Measured over a 42-case corpus:
  identical everywhere except 8 auto-detect-only cases, several of them
  strictly better picks (short SQL no longer classified as CSS). `showdown-highlight`
  stays a devDependency because the pinned upstream's `src/format.ts` imports
  it; the fork bundle no longer ships the 193-grammar registry.
- `custom-overlap` (longest-first matching): with two or more overlapping
  custom regexps, the fork runs the longest pattern first so the most
  specific match claims the region once; upstream runs insertion order and
  can add duplicate notes (short and long both claim). Single-pattern scans
  — including the `custom-regexp` fixture — are unaffected. Deliberately NOT
  extended to an inline-code guard: single-backtick spans and fences are
  already shielded via the existing `OBS_CODE_REGEXP`/`OBS_DISPLAY_CODE_REGEXP`
  ignore-spans, and odd-backtick counting would only cover exotic
  multi-backtick arrangements. The 2026-09 no-shielding NO-GO on primary
  scans is untouched (this only reorders `search()`, never `scanPattern`).

## Updating the upstream pin

1. `git fetch upstream master`
2. Re-run the parity suite against the new SHA.
3. If green, update `tests/parity/config.json` with the new SHA + date.
4. If red, triage before updating: new SHA must never be pinned red.
