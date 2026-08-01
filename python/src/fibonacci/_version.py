"""Single source of truth for the package version.

Kept in its own module so ``fibonacci/__init__.py`` can expose ``__version__``
without importing anything heavier, and so tooling (release scripts, the CLI's
``--version`` flag) can read it without importing the package at all.
"""

from __future__ import annotations

__version__ = "0.1.0"
