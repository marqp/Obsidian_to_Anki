# Mutation survivors log

Per AGENTS.md contribution rules, a surviving Stryker mutant becomes a new
test or a written justification — never a silent ignore. This file is the
written-justification side of that rule, plus a backlog of concrete kill
ideas for the rest.

- Scope: `stryker.config.mjs` (`src/scan-optimizations.ts`, `src/constants.ts`,
  `src/note.ts`, `src/setting-to-data.ts`), break threshold 60.
- Last reviewed: 2026-09-16 post-PR-10, score **91.75** (note.ts 93.66,
  constants.ts 100, setting-to-data 83.61). Peak was 92.09 after the kill-set
  PR (#23); PR-10 moved function bodies around, which reshuffles line numbers
  and the NoCoverage set (5 vs 3 in note.ts) without losing any killed mutant
  category. Baseline at release 4.0.0 was 80.10.

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

- Files outside the Stryker `mutate` list (`file.ts`, `files-manager.ts`,
  `format.ts`, `dry-run.ts`, `anki.ts`, …) have unit + parity + bench
  coverage but no mutation signal yet — see roadmap (extend scope after the
  Wave 2/3 test seams land; nightly-only if PR-time cost exceeds ~8 min).
- Mini-bug found while writing the kill-set (not a mutant): `RegexNote`
  with more captures than fields creates a junk `'undefined'` key
  (`note.ts` `getFields` loop bounds only on `captures`). Deliberately NOT
  fixed: the parity fixture `custom-regexp` pins the upstream-identical
  output including the junk key's `"undefined"` concat value (see
  "Parity-pinned behaviors" above). A fix would be a wire-format change
  needing an explicit CONTRACT.md divergence entry.
