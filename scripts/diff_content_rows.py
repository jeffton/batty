"""Recognize Batty's storage-only packed rows in SQLite maintenance scripts."""

import base64
import hashlib


def fingerprint(raw):
    return base64.urlsafe_b64encode(hashlib.sha256(raw.encode()).digest()).decode().rstrip("=")


class DiffContentRows:
    def __init__(self, db):
        self.db = db
        if db.execute("SELECT 1 FROM sqlite_schema WHERE name='batty_artifact_encoding_v1'").fetchone():
            namespace, self.writes_enabled = db.execute(
                "SELECT namespace,writes_enabled FROM batty_artifact_encoding_v1 WHERE id=1"
            ).fetchone()
            self.prefix = f"batty-artifact-v1:{namespace}:"
        else:
            self.prefix = None
            self.writes_enabled = False

    def packed(self, table, identity, raw):
        if self.prefix is None or self.prefix not in raw:
            return False
        digest = fingerprint(raw)
        return self.db.execute(
            "SELECT 1 FROM batty_artifact_rows_v1 WHERE owner=? AND identity=? AND digest=?",
            (table, str(identity), digest),
        ).fetchone() is not None

    def restore(self, table, identity, raw, digest):
        if digest is not None:
            if not self.writes_enabled:
                raise ValueError("Cannot restore packed artifacts into an inline-only database")
            if not self.prefix or self.prefix not in raw or fingerprint(raw) != digest:
                raise ValueError(f"Invalid packed row fingerprint: {table}:{identity}")
            self.db.execute("""INSERT INTO batty_artifact_rows_v1 VALUES (?,?,?)
                ON CONFLICT(owner,identity) DO UPDATE SET digest=excluded.digest""", (table, identity, digest))
        elif self.prefix is not None:
            self.db.execute("DELETE FROM batty_artifact_rows_v1 WHERE owner=? AND identity=?", (table, identity))
