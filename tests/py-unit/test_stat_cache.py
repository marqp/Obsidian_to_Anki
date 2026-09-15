"""Unit tests for the stat fast-path cache in obsidian_to_anki.py.

Mirrors the TypeScript isStatUnchanged/getStoredHash contract: new cache
entries are {"hash", "mtime", "size"} dicts, legacy entries are plain hash
strings, and only a full mtime+size match may skip the disk read.
"""

import hashlib
import os

import obsidian_to_anki as o2a


def test_get_stored_hash_legacy_string():
    assert o2a.get_stored_hash("abc123") == "abc123"


def test_get_stored_hash_new_entry():
    assert o2a.get_stored_hash({"hash": "abc123", "mtime": 1.0, "size": 42}) == "abc123"


def test_get_stored_hash_missing():
    assert o2a.get_stored_hash(None) is None
    assert o2a.get_stored_hash({}) is None


class _Stat:
    def __init__(self, mtime, size):
        self.st_mtime = mtime
        self.st_size = size


def test_is_stat_unchanged_match():
    entry = {"hash": "abc", "mtime": 100.0, "size": 42}
    assert o2a.is_stat_unchanged(_Stat(100.0, 42), entry) is True


def test_is_stat_unchanged_mismatch():
    entry = {"hash": "abc", "mtime": 100.0, "size": 42}
    assert o2a.is_stat_unchanged(_Stat(101.0, 42), entry) is False
    assert o2a.is_stat_unchanged(_Stat(100.0, 43), entry) is False


def test_is_stat_unchanged_legacy_or_missing():
    assert o2a.is_stat_unchanged(_Stat(100.0, 42), "abc") is False
    assert o2a.is_stat_unchanged(_Stat(100.0, 42), None) is False
    assert o2a.is_stat_unchanged(None, {"hash": "a", "mtime": 1.0, "size": 1}) is False


def _vault_key(name):
    return os.path.join(".", name)


def test_directory_skips_read_when_stat_matches(tmp_path, monkeypatch):
    """Stat match must skip File instantiation entirely (zero disk reads)."""
    target = tmp_path / "note.md"
    target.write_text("START\nBasic\nFront: Q\nBack: A\nEND", encoding="utf-8")
    stat = target.stat()
    monkeypatch.setitem(o2a.CONFIG_DATA, "Vault", "")
    monkeypatch.setattr(
        o2a.App,
        "FILE_HASHES",
        {_vault_key("note.md"): {"hash": "stale-would-fail", "mtime": stat.st_mtime, "size": stat.st_size}},
        raising=False,
    )

    def _explode(filepath):
        raise AssertionError(f"File instantiated for unchanged {filepath}")

    monkeypatch.setattr(o2a, "File", _explode)
    cwd = os.getcwd()
    try:
        directory = o2a.Directory(str(tmp_path))
    finally:
        os.chdir(cwd)
    assert directory.files == []


def test_directory_falls_back_to_hash_for_legacy_entries(tmp_path, monkeypatch):
    """Legacy string entries still work via content-hash comparison."""
    content = "START\nBasic\nFront: Q\nBack: A\nEND"
    target = tmp_path / "note.md"
    target.write_text(content, encoding="utf-8")
    legacy_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
    monkeypatch.setitem(o2a.CONFIG_DATA, "Vault", "")
    monkeypatch.setattr(
        o2a.App, "FILE_HASHES", {_vault_key("note.md"): legacy_hash}, raising=False
    )

    constructed = []

    class CountingFile(o2a.File):
        def __init__(self, filepath):
            constructed.append(filepath)
            super().__init__(filepath)

    monkeypatch.setattr(o2a, "File", CountingFile)
    cwd = os.getcwd()
    try:
        directory = o2a.Directory(str(tmp_path))
    finally:
        os.chdir(cwd)
    # File was read (fallback), hash matched, so nothing to scan.
    assert len(constructed) == 1
    assert directory.files == []


def test_hashes_writes_stat_entries(tmp_path, monkeypatch):
    monkeypatch.setitem(o2a.CONFIG_DATA, "Vault", "")
    target = tmp_path / "note.md"
    content = "START\nBasic\nFront: Q\nBack: A\nEND"
    target.write_text(content, encoding="utf-8")
    stat = target.stat()

    file_obj = o2a.File(str(target))
    directory = o2a.Directory.__new__(o2a.Directory)
    directory.files = [file_obj]

    hashes = directory.hashes()
    entry = hashes[file_obj.filename]
    assert entry["hash"] == hashlib.sha256(content.encode("utf-8")).hexdigest()
    assert entry["mtime"] == stat.st_mtime
    assert entry["size"] == stat.st_size
