"""Unit tests for string_insert and span helpers in obsidian_to_anki.py.

These are pure functions (no Anki, no disk, no config) — the cheapest safety
net for the surgical optimizations in B1.
"""

import re

import obsidian_to_anki as o2a


def test_string_insert_docstring_example():
    assert o2a.string_insert("abcde", [(0, "hi"), (3, "hello"), (5, "beep")]) == "hiabchellodebeep"


def test_string_insert_empty_inserts():
    assert o2a.string_insert("abc", []) == "abc"


def test_string_insert_unsorted_and_adjacent():
    assert o2a.string_insert("ab", [(2, "Y"), (0, "X"), (1, "Z")]) == "XaZbY"


def test_string_insert_many_ids_scale_linearly():
    # Simulates stamping one ID per note in a large file: result must be exact
    # and complete in a single pass (guards the O(N*L) realloc rewrite).
    base = "x" * 10_000
    inserts = [(i * 100, f"<!--ID: {i}-->") for i in range(100)]
    result = o2a.string_insert(base, inserts)
    assert len(result) == 10_000 + sum(len(f"<!--ID: {i}-->") for i in range(100))
    for i in range(100):
        assert f"<!--ID: {i}-->" in result


def test_spans_returns_match_spans():
    pattern = re.compile(r"ab")
    assert o2a.spans(pattern, "ab--ab") == [(0, 2), (4, 6)]


def test_contained_in_with_leeway():
    spans = [(10, 20)]
    assert o2a.contained_in((11, 19), spans) is True
    # +-1 leeway on both edges
    assert o2a.contained_in((9, 21), spans) is True
    assert o2a.contained_in((0, 5), spans) is False
    assert o2a.contained_in((21, 30), spans) is False


def test_findignore_skips_ignored_spans():
    pattern = re.compile(r"NOTE")
    text = "NOTE keep NOTE"
    # Second NOTE (offset 10-14) sits inside the ignore span
    matches = list(o2a.findignore(pattern, text, [(9, 15)]))
    assert [m.group(0) for m in matches] == ["NOTE"]
    assert matches[0].span() == (0, 4)


def test_search_patterns_compiled_once_and_shared():
    first = o2a.search_patterns(r"CUSTOM")
    second = o2a.search_patterns(r"CUSTOM")
    assert first is second
    assert len(first) == 4
    # Plain variant still matches like an inline re.compile would
    assert first[3].search("xx CUSTOM yy") is not None
    # Distinct patterns get distinct entries
    assert o2a.search_patterns(r"OTHER") is not first
