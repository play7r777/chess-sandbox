"""Download and import the Lichess puzzle database into a local SQLite file.

Usage::

    python -m backend.import_puzzles              # default 500 000 puzzles
    python -m backend.import_puzzles --target 100000
    python -m backend.import_puzzles --all        # import every puzzle (~5.5M)

The script streams ``lichess_db_puzzle.csv.zst`` from
https://database.lichess.org, decompresses on-the-fly with *zstandard*,
reservoir-samples the requested number of puzzles, then inserts them into
``backend/data/puzzles.sqlite``.

The download is cached: if the ``.csv.zst`` already exists in
``backend/data/`` the local copy is reused (delete it to force a
re-download).
"""
from __future__ import annotations

import argparse
import csv
import io
import random
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any

import requests  # type: ignore[import-untyped]
import zstandard  # type: ignore[import-untyped]

# ── Constants ───────────────────────────────────────────────────────
DB_URL = "https://database.lichess.org/lichess_db_puzzle.csv.zst"
DATA_DIR = Path(__file__).resolve().parent / "data"
ZST_PATH = DATA_DIR / "lichess_db_puzzle.csv.zst"
DB_PATH = DATA_DIR / "puzzles.sqlite"

CHUNK_SIZE = 1 << 20  # 1 MiB for download streaming


# ── Difficulty band (must match puzzles.py / puzzle_db.py) ──────────
def _difficulty(rating: int) -> str:
    if rating < 1100:
        return "easy"
    if rating < 1700:
        return "medium"
    return "hard"


# ── Download ────────────────────────────────────────────────────────
def _download(url: str, dest: Path) -> None:
    """Stream-download *url* into *dest* with a progress counter."""
    print(f"Скачиваю {url} ...")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".zst.part")
    r = requests.get(url, stream=True, timeout=60)
    r.raise_for_status()
    total = int(r.headers.get("content-length", 0))
    done = 0
    t0 = time.monotonic()
    with tmp.open("wb") as f:
        for chunk in r.iter_content(CHUNK_SIZE):
            f.write(chunk)
            done += len(chunk)
            elapsed = time.monotonic() - t0
            speed = done / elapsed / 1e6 if elapsed else 0
            if total:
                pct = done / total * 100
                print(f"\r  {done / 1e6:.1f} / {total / 1e6:.1f} MB ({pct:.0f}%) – "
                      f"{speed:.1f} MB/s", end="", flush=True)
            else:
                print(f"\r  {done / 1e6:.1f} MB – {speed:.1f} MB/s",
                      end="", flush=True)
    print()
    tmp.rename(dest)
    print(f"Сохранено: {dest} ({dest.stat().st_size / 1e6:.1f} MB)")


# ── Streaming CSV parse + reservoir sample ──────────────────────────
def _stream_puzzles(
    zst_path: Path,
    target: int | None,
) -> list[tuple[str, str, str, int, int, int, int, str, str, str]]:
    """Return up to *target* puzzles (reservoir-sampled if target is set).

    Each row is (id, fen, moves, rating, rating_dev, popularity, plays,
    themes, url, opening_tags).
    """
    dctx = zstandard.ZstdDecompressor()
    reservoir: list[tuple[str, str, str, int, int, int, int, str, str, str]] = []
    n = 0
    t0 = time.monotonic()

    with zst_path.open("rb") as fh:
        reader_stream = dctx.stream_reader(fh)
        text_stream = io.TextIOWrapper(reader_stream, encoding="utf-8")
        csv_reader = csv.reader(text_stream)
        header = next(csv_reader, None)
        if not header:
            print("CSV пустой — прерываю.")
            return []
        # Expected columns:
        # PuzzleId, FEN, Moves, Rating, RatingDeviation, Popularity,
        # NbPlays, Themes, GameUrl, OpeningTags
        for row in csv_reader:
            if len(row) < 8:
                continue
            try:
                rating = int(row[3])
                rating_dev = int(row[4]) if len(row) > 4 and row[4] else 0
                popularity = int(row[5]) if len(row) > 5 and row[5] else 0
                plays = int(row[6]) if len(row) > 6 and row[6] else 0
            except ValueError:
                continue
            entry = (
                row[0],                          # id
                row[1],                          # fen
                row[2],                          # moves (space-separated)
                rating,
                rating_dev,
                popularity,
                plays,
                row[7] if len(row) > 7 else "",  # themes
                row[8] if len(row) > 8 else "",  # url
                row[9] if len(row) > 9 else "",  # opening_tags
            )

            if target is None:
                # Import all — just append.
                reservoir.append(entry)
            else:
                # Reservoir sampling (Algorithm R).
                if n < target:
                    reservoir.append(entry)
                else:
                    j = random.randint(0, n)
                    if j < target:
                        reservoir[j] = entry
            n += 1
            if n % 200_000 == 0:
                elapsed = time.monotonic() - t0
                kept = len(reservoir)
                print(f"\r  Прочитано {n:,} строк, выбрано {kept:,} — "
                      f"{elapsed:.0f} с", end="", flush=True)

    elapsed = time.monotonic() - t0
    print(f"\r  Итого: {n:,} строк → {len(reservoir):,} пазлов за {elapsed:.0f} с")
    return reservoir


# ── SQLite insertion ────────────────────────────────────────────────
_CREATE_SQL = """\
CREATE TABLE IF NOT EXISTS puzzles (
    id          TEXT PRIMARY KEY,
    fen         TEXT NOT NULL,
    moves       TEXT NOT NULL,
    rating      INTEGER NOT NULL,
    rating_dev  INTEGER NOT NULL DEFAULT 0,
    popularity  INTEGER NOT NULL DEFAULT 0,
    plays       INTEGER NOT NULL DEFAULT 0,
    themes      TEXT NOT NULL DEFAULT '',
    url         TEXT NOT NULL DEFAULT '',
    opening_tags TEXT NOT NULL DEFAULT '',
    difficulty  TEXT NOT NULL DEFAULT 'medium'
);
"""

_INDEX_SQL = [
    "CREATE INDEX IF NOT EXISTS idx_puzzles_rating ON puzzles(rating);",
    "CREATE INDEX IF NOT EXISTS idx_puzzles_difficulty ON puzzles(difficulty);",
]


def _insert(db_path: Path, rows: list[tuple[Any, ...]]) -> None:
    tmp_path = db_path.with_suffix(".sqlite.tmp")
    if tmp_path.exists():
        tmp_path.unlink()
    conn = sqlite3.connect(str(tmp_path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute(_CREATE_SQL)
    for idx_sql in _INDEX_SQL:
        conn.execute(idx_sql)
    conn.commit()

    print("Записываю в SQLite ...")
    t0 = time.monotonic()
    cur = conn.cursor()
    batch: list[tuple[Any, ...]] = []
    for i, r in enumerate(rows):
        difficulty = _difficulty(int(r[3]))
        batch.append((*r, difficulty))
        if len(batch) >= 50_000:
            cur.executemany(
                "INSERT OR IGNORE INTO puzzles "
                "(id, fen, moves, rating, rating_dev, popularity, plays, "
                "themes, url, opening_tags, difficulty) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                batch,
            )
            conn.commit()
            print(f"\r  {i + 1:,} / {len(rows):,}", end="", flush=True)
            batch = []
    if batch:
        cur.executemany(
            "INSERT OR IGNORE INTO puzzles "
            "(id, fen, moves, rating, rating_dev, popularity, plays, "
            "themes, url, opening_tags, difficulty) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            batch,
        )
        conn.commit()
    conn.close()
    elapsed = time.monotonic() - t0
    print(f"\r  Готово: {len(rows):,} строк за {elapsed:.1f} с")

    # Atomic rename.
    if db_path.exists():
        db_path.unlink()
    tmp_path.rename(db_path)
    print(f"База: {db_path} ({db_path.stat().st_size / 1e6:.1f} MB)")


# ── CLI ─────────────────────────────────────────────────────────────
def main() -> None:
    parser = argparse.ArgumentParser(
        description="Импорт пазлов Lichess → SQLite",
    )
    parser.add_argument(
        "--target", type=int, default=500_000,
        help="Целевое количество пазлов (по умолчанию 500 000)",
    )
    parser.add_argument(
        "--all", action="store_true",
        help="Импортировать все пазлы (~5.5M) без семплинга",
    )
    parser.add_argument(
        "--url", default=DB_URL,
        help="URL .csv.zst (по умолчанию Lichess)",
    )
    args = parser.parse_args()

    target: int | None = None if args.all else args.target

    # Download if missing.
    if not ZST_PATH.exists():
        _download(args.url, ZST_PATH)
    else:
        print(f"Используем кэш: {ZST_PATH} ({ZST_PATH.stat().st_size / 1e6:.1f} MB)")

    # Parse + sample.
    rows = _stream_puzzles(ZST_PATH, target)
    if not rows:
        print("Нет пазлов — выход.")
        sys.exit(1)

    # Insert into SQLite.
    _insert(DB_PATH, rows)
    print(f"\nГотово! {len(rows):,} пазлов доступны серверу.")


if __name__ == "__main__":
    main()
