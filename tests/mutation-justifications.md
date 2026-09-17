# Mutation survivors log

Per AGENTS.md contribution rules, a surviving Stryker mutant becomes a new
test or a written justification — never a silent ignore. This file is the
written-justification side of that rule, plus a backlog of concrete kill
ideas for the rest.

- Scope: `stryker.config.mjs` — full engine (every `src/` module except
  `settings.ts`, which is Obsidian-UI without a DOM in tests). Extended in
  Wave 5 (PR-15); previously only `scan-optimizations.ts`, `constants.ts`,
  `note.ts`, `setting-to-data.ts`.
- Last reviewed: 2026-09-17 post-PR-15, score **70.44** (break threshold 60).
  requests.ts 100, notices.ts 100, commands.ts 100, constants.ts 100;
  dry-run.ts 82.96, anki.ts 85.40, scan-orchestrator.ts 83.33.
  Pre-extension peak was 92.09 on the 4-file scope — the drop is new files
  with real tests but incomplete perTest attribution (see mapping misses),
  plus pre-existing parse-heavy gaps now visible (file/files-manager/format
  backlog below). Baseline at release 4.0.0 was 80.10.

## Parity-pinned behaviors (do not "fix")

- `format_note_with_frozen_fields` concatenates `value + frozen[field]` with
  NO `?? ''` fallback: for a field key without a frozen entry this yields the
  literal string `"undefined"` (reachable via the junk key custom regexps can
  produce). PR-10 tried the "defensive" fallback and the `custom-regexp`
  parity fixture caught the wire-format change immediately. Unit-pinned in
  `format.test.ts` ("keeps parity-pinned concat semantics…").

## How to use this file

1. Before touching a line listed here, write the killing test first.
2. When a mutant below is killed, delete its entry in the same commit.
3. Suspected perTest-mapping miss (test exists, mutant still reported)?
   Verify by hand: apply the replacement to a scratch copy, run only the
   suspect test file (`pnpm exec vitest run <file>`), confirm red, restore.
   Worked example (2026-09-16): `note.ts` `TAG_REGEXP_STR` `` `(Tags: .*)` ``
   → ``` `` ``` survived despite `file-scan.test.ts` covering it; manual
   application failed the suite as expected, and a strengthened assertion
   (`not.toContain('s:')`) made the official run kill it. The first
   assertion (`toContain('mytag')`) was too loose — membership survived
   inside a mangled slice.

## Accepted survivors (keep, do not "fix")

### perTest-mapping misses (hand-verified red, Stryker reports Survived)

Stryker runs ~7 tests per mutant on average here, and the attribution is
incomplete: several mutants die immediately when their owning suite runs
but survive the official run. Verified by hand (apply replacement to a
scratch copy, run only the suspect file, confirm red, restore):

- `src/anki.ts` L12 error-message template → `""`: `transport.test.ts`
  fails 2 tests by hand. Genuine tests exist; attribution misses them.
- `src/scan-orchestrator.ts` L125 `probe.status === 'ready'` → `false`:
  `scan-orchestrator.test.ts` fails 9 tests by hand. Same verdict covers
  the ready/auto-launch/scanDirs/cancel/no-changes string and branch
  survivors in that file (L135–L225): the owning suite asserts every one
  of those strings and branches.
- `src/dry-run.ts` L125 convert `changes.push` removal: `dry-run.test.ts`
  fails the convert test by hand (`find` returns `undefined`).
- `src/scan-orchestrator.ts` bypassConfirm routing (`if (true)` forcing the
  modal path): `scan-orchestrator.test.ts` fails 3 tests by hand (direct
  sync, bypass, and setting-off routing). Verdict covers the neighboring
  confirm/empty/fallback string and branch survivors in `runPreviewSync`.
- `src/scan-orchestrator.ts` commit-failure notice → `'ok'`: the
  runPreviewSync commit-failure test fails by hand.
- `src/dry-run-view.ts` group-sort comparator (`true ? 1 : 0`): passes the
  view suite by hand too — V8 binary insertion still orders ≤22 distinct
  keys correctly under this inconsistent comparator, so it is unobservable
  at realistic group counts; see equivalent entry below.
- Same signature (assertion exists, mutant survives) for `dry-run.ts`
  L177 tag-compare → `false` (old exact-diff test id 13), L185/L188 deck
  comparison (deck-move test), and `src/anki.ts` L97 FetchTransport
  `if (data.error)` both directions (success + error tests exist).
- `src/dry-run.ts` preflight loop bounds (`<` → `<=`): killed, not missed —
  the exact-boundary test (256 ids → exactly 1 call) fails by hand.
- Protocol: before "fixing" any survivor below, hand-verify first — a red
  run means the test already exists and only the attribution is missing.

### Equivalent mutants (unobservable, keep)

- `src/dry-run-view.ts` L43 group-sort comparator (`<`→`<=`, `>`→`>=`,
  `>`→`<=`): group keys are map keys, hence always distinct — the variants
  preserve strict weak ordering on distinct strings. Ordering itself is
  pinned by the reversed 4-group test (any order-changing mutant, e.g. the
  `noteId ?? 0` removal, dies). Deliberately locale-independent code-unit
  comparison, not `localeCompare`.

- `src/defaults-meta.ts` L104 `[...meta.value]` → `[]`: the only array
  value in the table is already empty, so the spread is unobservable.
  Becomes observable (and killed) the day a non-empty array default lands.
- `src/dry-run.ts` L103 `if (identifier == null) continue` removal: falls
  through to the `!anki` guard on the next line, which skips identically.
- `src/dry-run.ts` L163 single-tag sets: `.some()` vs `.every()` converge
  when both tag lists have ≤ 1 element (the tag-diff fixture); extend the
  fixture to multi-tag divergence to separate them (backlog).
- `src/note.ts` L340/L341, L207/L220, L244, L281, L293 entries from the
  pre-extension scope are unchanged (see below).

## Out of scope for this log

### src/note.ts

- L149 `this.delete = false` → `true`: the `delete` field is write-only —
  no reader in `src/`, `main.ts` or tests. Keep as documentation of intent;
  follow-up: delete the field (dead, zero-risk, needs no test).
- L207/L220 `lastLine === undefined` guards: `String.split` never yields an
  empty array, so the guard is unreachable via the public API. Keep as
  defensive code (also covers the NoCoverage twin on L207).
- L244 `if (!this.field_names) return {}`: `field_names` is always an array
  (default `[]`). Defensive; unreachable.
- L262/L263 `InlineNote.getSplitText` override: its result is never read —
  `getFields` re-splits `this.text` itself. Dead override; follow-up: delete
  it (and confirm `AbstractNote` still requires the method for `Note`).
- L281 `.trim()` on the tags slice: masked downstream by design —
  `formatNoteFields` trims every field before formatting, so the trim here
  is defense in depth. Removing it would be behavior-neutral today and
  brittle tomorrow; keep.
- L293 `result.index ?? 0`: `String.match` always sets `index` on success,
  so the fallback is dead; `index > 0` is unreachable in valid flows
  (ID/tags are always trailing when present). Keep.

## Future kill-set (concrete test ideas, highest value first)

### src/scan-optimizations.ts

- L21 `if (!entry) return undefined`: call `getStoredHash` with an unknown
  path, assert `undefined` (currently only hit paths are tested).
- L110 `typeof cachedEntry === 'string'` → `""`: feed a legacy string hash
  entry (the `FileHashes` string shape AGENTS.md documents) and assert it is
  treated as a hash, not an object.
- L117 `hasOwnProperty` guard (×2): `isFileUnchanged` on a path absent from
  `file_hashes`.
- L121 `&&` → `true`: `isFileUnchanged` with changed content asserting `false`.
- L161 `fields: { ...data.template.fields }` → `{}`: `createFileData`
  asserting template fields are copied, not dropped.
- L132/L134/L181: accepted as unobservable (empty-input short-circuit is
  equivalent to mapping over `[]`; `new Array(n)` vs `new Array()` converge
  after indexed assignment; `yieldToEventLoop` removal is timing-only).

### src/setting-to-data.ts

All ten are `String.raw` fragments and regexp flags — killable with sharper
`settingToData` unit tests asserting built-regexp behavior (not strings):
mid-line `TARGET DECK`/`FILE TAGS` must NOT match once the `^` anchor is
removed (kills L46/L50); `FROZEN`/`DELETE` lines must not match without `m`
(kills L43/L47/L51); missing `Delete Removed Notes` key must default `true`
(kills L77); empty flag strings must break matching (kills L42/L54/L58/L67).

### src/note.ts NoCoverage

- L101 `'<br>'` separator: needs an explicit context-append test asserting
  the separator itself (current tests cover the path, not the literal).
- L340/L341 `this.match.pop() ?? ''` fallbacks (new in PR-10, replacing the
  `!` assertions): unreachable under the `search()` flag contract (the group
  exists when the flag is on), so no test can distinguish the fallback;
  `parseInt('') -> NaN` is the pinned equivalent. Keep as defensive code.
- L362 `url = ''` default: call `parse()` without the url argument once.

## Out of scope for this log

- `settings.ts` stays out of both gates (Obsidian-UI, 47% lines, no DOM in
  tests). Deliberate, documented in `vitest.config.mjs`.
- `file.ts` (54.43), `files-manager.ts` (48.71), `format.ts` (47.79) have
  pre-existing parse-heavy gaps now visible under the extended scope
  (64/61/44 NoCoverage mutants). They are covered by unit + parity + bench,
  but were never mutation-tested. Incremental kill-sets welcome; highest
  value first: `files-manager.ts` orphan/media branches (ports seam makes
  them testable without Obsidian), `file.ts` custom-regexp paths,
  `format.ts` cloze branches.
- Mini-bug found while writing the kill-set (not a mutant): `RegexNote`
  with more captures than fields creates a junk `'undefined'` key
  (`note.ts` `getFields` loop bounds only on `captures`). Deliberately NOT
  fixed: the parity fixture `custom-regexp` pins the upstream-identical
  output including the junk key's `"undefined"` concat value (see
  "Parity-pinned behaviors" above). A fix would be a wire-format change
  needing an explicit CONTRACT.md divergence entry.
