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

## Warning comparison policy

Warnings are compared by category (`unknown-id`, `unknown-model`,
`cloze-skip`), not string-exact. Text-only diffs in warnings do not break
parity; parse/ID/delete diffs do, and require a fix or a written justification
appended to this file.

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

## Updating the upstream pin

1. `git fetch upstream master`
2. Re-run the parity suite against the new SHA.
3. If green, update `tests/parity/config.json` with the new SHA + date.
4. If red, triage before updating: new SHA must never be pinned red.
