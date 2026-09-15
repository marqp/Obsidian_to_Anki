"""Parity tests for note-block detection in obsidian_to_anki.py.

Mirrors the TypeScript regression (commit b8ee77d): blocks whose START/END
markers carry trailing spaces must still be detected. Uses the real
App.gen_regexp builder, not a replica.
"""

import re

import obsidian_to_anki as o2a


def _build_note_regexp(begin="START", end="END"):
    o2a.CONFIG_DATA["NOTE_PREFIX"] = re.escape(begin)
    o2a.CONFIG_DATA["NOTE_SUFFIX"] = re.escape(end)
    o2a.CONFIG_DATA["INLINE_PREFIX"] = re.escape("STARTI")
    o2a.CONFIG_DATA["INLINE_SUFFIX"] = re.escape("ENDI")
    o2a.CONFIG_DATA["DECK_LINE"] = re.escape("TARGET DECK")
    o2a.CONFIG_DATA["TAG_LINE"] = re.escape("FILE TAGS")
    o2a.CONFIG_DATA["FROZEN_LINE"] = re.escape("FROZEN")
    o2a.CONFIG_DATA["Vault"] = ""
    o2a.App.gen_regexp(object())
    return o2a.App.NOTE_REGEXP


def test_standard_block_matches():
    regexp = _build_note_regexp()
    content = "START\nBasic\nFront: What is 2+2?\nBack: 4\nEND"
    matches = list(regexp.finditer(content))
    assert len(matches) == 1
    assert "Front: What is 2+2?" in matches[0].group(1)


def test_trailing_spaces_after_markers_match():
    # Parity with TypeScript fix b8ee77d: 'START   \\n' and 'END   ' must match.
    regexp = _build_note_regexp()
    content = "START   \nBasic\nFront: Q1\nBack: A1\nEND   \n\nSTART \nBasic\nFront: Q2\nBack: A2\nEND "
    matches = list(regexp.finditer(content))
    assert len(matches) == 2
    assert "Q1" in matches[0].group(1)
    assert "Q2" in matches[1].group(1)


def test_crlf_line_endings_match():
    regexp = _build_note_regexp()
    content = "START\r\nBasic\r\nFront: Q\r\nBack: A\r\nEND"
    matches = list(regexp.finditer(content))
    assert len(matches) == 1
