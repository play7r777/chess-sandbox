"""Project-root and data-directory resolution.

These helpers exist to keep the server and the importer on the same
``backend/data/`` folder even when Python loads the ``backend`` package
from an unexpected location.

Concretely: on Windows users often pull the repo into a new folder
("...(9)") while ``pip install -e`` from a *previous* checkout
("...(4)") still wires the ``backend`` package to the old path inside
the system Python's ``site-packages``. As a result:

* ``python -m backend.import_puzzles`` run from inside the new repo
  (e.g. ``...(9)\\scripts``) resolves the editable install and writes
  the SQLite to ``...(4)\\backend\\data\\puzzles.sqlite``.
* ``python -m uvicorn backend.main:app`` run from the new repo root
  imports ``backend`` from the *current* directory (because cwd wins
  over ``site-packages`` in ``sys.path``) and looks for the SQLite at
  ``...(9)\\backend\\data\\puzzles.sqlite`` — which is empty, so the
  server falls back to the bundled 90-puzzle JSON pack.

Resolving every mutable-state path from a *cwd-derived* project root
makes both processes agree on a single ``backend/data/`` directory,
regardless of where the package itself was installed from. The walk
finds the nearest ancestor that contains ``pyproject.toml`` *and* a
``backend/`` sub-directory, which is unambiguous for this repo.

If no such ancestor exists (e.g. the package was installed from a
built wheel and the user runs the command from an unrelated cwd) we
fall back to the directory next to this file, which matches the old
behaviour.
"""
from __future__ import annotations

import os
from pathlib import Path

_MODULE_DIR = Path(__file__).resolve().parent  # .../backend
_MODULE_PARENT = _MODULE_DIR.parent            # .../<repo>


def _is_project_root(candidate: Path) -> bool:
    """A directory looks like our repo root iff it has pyproject.toml *and* backend/."""
    return (candidate / "pyproject.toml").is_file() and (candidate / "backend").is_dir()


def find_project_root(start: Path | None = None) -> Path | None:
    """Walk up from ``start`` (default: cwd) looking for our repo marker.

    Returns the first ancestor (inclusive of ``start``) that contains
    both ``pyproject.toml`` and a ``backend/`` sub-directory, or
    ``None`` when no such ancestor exists.
    """
    base = (start or Path.cwd()).resolve()
    for parent in [base, *base.parents]:
        if _is_project_root(parent):
            return parent
    return None


def resolve_project_root() -> Path:
    """Return the project root we should treat as authoritative.

    Precedence:
      1. ``$CHESS_PROJECT_ROOT`` if set and valid.
      2. Nearest ancestor of cwd that looks like our repo.
      3. The directory that contains the loaded ``backend`` package.
    """
    env_override = os.environ.get("CHESS_PROJECT_ROOT")
    if env_override:
        candidate = Path(env_override).expanduser().resolve()
        if _is_project_root(candidate):
            return candidate

    cwd_root = find_project_root()
    if cwd_root is not None:
        return cwd_root

    return _MODULE_PARENT


def resolve_data_dir() -> Path:
    """Return the ``backend/data/`` directory we should read/write mutable state from.

    Honours ``$CHESS_DATA_DIR`` when set (handy for tests or unusual
    installs) — otherwise hangs off :func:`resolve_project_root`.
    """
    env_override = os.environ.get("CHESS_DATA_DIR")
    if env_override:
        return Path(env_override).expanduser().resolve()
    return resolve_project_root() / "backend" / "data"


def module_dir() -> Path:
    """Return the directory of the loaded ``backend`` package."""
    return _MODULE_DIR


def module_parent() -> Path:
    """Return the directory *containing* the loaded ``backend`` package."""
    return _MODULE_PARENT


def stale_install_warning() -> str | None:
    """Return a human-readable warning when ``__file__`` and the cwd-derived root disagree.

    Used by the startup banner to flag stale ``pip install -e`` setups
    pointing at a sibling checkout. Returns ``None`` when everything
    lines up.
    """
    cwd_root = find_project_root()
    if cwd_root is None:
        return None
    if cwd_root.resolve() == _MODULE_PARENT.resolve():
        return None
    return (
        "Пакет backend загружен из "
        f"{_MODULE_PARENT}, но текущий проект — {cwd_root}. "
        "Похоже, в системном Python остался старый `pip install -e ...` из соседнего "
        "checkout-а. Скрипты будут писать данные в "
        f"{cwd_root / 'backend' / 'data'} (cwd-based), но код выполняется из старой папки. "
        "Чтобы убрать рассинхрон навсегда, создай локальный venv и переустанови пакет:\n"
        "    py -3.11 -m venv .venv\n"
        "    .venv\\Scripts\\pip install -e ."
    )
