import sqlite3
from pathlib import Path


class DownloadState:
    def __init__(self, db_path: str = "data/downloads.db"):
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(db_path)
        self._init_tables()

    def _init_tables(self):
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS downloads (
                ecosystem     TEXT NOT NULL,
                slug          TEXT NOT NULL,
                version       TEXT NOT NULL,
                file_path     TEXT,
                file_hash     TEXT,
                downloaded_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (ecosystem, slug, version)
            )
        """)
        self.conn.commit()

    def is_downloaded(self, ecosystem: str, slug: str, version: str) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM downloads WHERE ecosystem=? AND slug=? AND version=?",
            (ecosystem, slug, version),
        ).fetchone()
        return row is not None

    def record(self, ecosystem: str, slug: str, version: str,
               file_path: str, file_hash: str | None = None):
        self.conn.execute(
            """INSERT OR REPLACE INTO downloads (ecosystem, slug, version, file_path, file_hash)
               VALUES (?, ?, ?, ?, ?)""",
            (ecosystem, slug, version, file_path, file_hash),
        )
        self.conn.commit()

    def stats(self) -> dict[str, int]:
        rows = self.conn.execute(
            "SELECT ecosystem, COUNT(*) FROM downloads GROUP BY ecosystem"
        ).fetchall()
        return {row[0]: row[1] for row in rows}
