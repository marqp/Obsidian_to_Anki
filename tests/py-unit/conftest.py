"""Pytest bootstrap for tests/py-unit.

The CLI script imports third-party packages (`markdown`) that are only needed
for its formatting/GUI paths. Unit tests exercise pure helpers, so stub those
imports instead of installing the full 2020-era dependency tree. The E2E suite
(tests/anki) is unaffected: it never imports obsidian_to_anki.
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

for _module_name in ("markdown",):
    sys.modules.setdefault(_module_name, MagicMock())
