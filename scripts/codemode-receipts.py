#!/usr/bin/env python3
"""Targeted, reversible retirement of settled legacy codemode results."""

import argparse
import hashlib
import json
import os
import sqlite3
from pathlib import Path

KIND = "batty.codemode-tool"
COLUMNS = "id, conversation_id, kind, status, abort_requested, background, record"
MARKER = {"released": True}


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def row_hash(row):
    return digest(json.dumps(list(row), ensure_ascii=False, separators=(",", ":")))


def connect(path, writable=False):
    path = Path(path).resolve(strict=True)
    db = sqlite3.connect(path.as_uri() + ("?mode=rw" if writable else "?mode=ro"), uri=True)
    db.execute("PRAGMA busy_timeout=30000")
    return db


def metadata(db, task_id):
    return db.execute(
        "SELECT conversation_id, status, json_extract(record, '$.owner') FROM tasks WHERE id=?",
        (task_id,),
    ).fetchone()


def protected_tasks(db):
    """Protect live conversations and ownership ancestors across both record types."""
    tasks = set()
    conversations = set()
    pending = [("task", row[0]) for row in db.execute(
        "SELECT id FROM tasks WHERE status != 'terminal'"
    )]
    while pending:
        kind, identity = pending.pop()
        protected = tasks if kind == "task" else conversations
        if identity in protected:
            continue
        protected.add(identity)
        if kind == "task":
            info = metadata(db, identity)
            if info is not None:
                pending.append(("conversation", info[0]))
                if info[2] is not None:
                    pending.append(("task", info[2]))
        else:
            owner = db.execute(
                "SELECT owner_conversation_id, owner_task_id FROM conversations WHERE id=?",
                (identity,),
            ).fetchone()
            if owner is not None:
                if owner[0] is not None:
                    pending.append(("conversation", owner[0]))
                if owner[1] is not None:
                    pending.append(("task", owner[1]))
    return tasks, conversations


def eligible(db, row, protected):
    task_id, conversation, kind, status, _, _, raw = row
    record = json.loads(raw)
    state = record.get("state", {})
    outcome = state.get("outcome", {})
    payload = outcome.get("result")
    if not (
        kind == json.dumps(KIND) and status == "terminal" and record.get("version") == 2
        and record.get("id") == task_id and record.get("conversationId") == conversation
        and record.get("kind") == KIND and state.get("status") == "terminal"
        and outcome.get("status") == "completed" and isinstance(payload, dict)
        and set(payload) == {"result", "structured"} and isinstance(payload["result"], dict)
    ):
        return False
    seen = {task_id}
    protected_ids, protected_conversations = protected
    if task_id in protected_ids or conversation in protected_conversations:
        return False
    owner = record.get("owner")
    # SDK TaskRecord.owner is absent exactly for a conversation-owned root.
    while owner is not None:
        if owner in seen or owner in protected_ids:
            return False
        seen.add(owner)
        info = metadata(db, owner)
        if info is None or info[0] != conversation or info[1] != "terminal":
            return False
        owner = info[2]
    return True


def replacement(raw):
    record = json.loads(raw)
    record["state"]["outcome"]["result"] = MARKER
    return json.dumps(record, ensure_ascii=False, separators=(",", ":"))


def candidates(db):
    return db.execute(
        f"SELECT {COLUMNS} FROM tasks WHERE kind=? AND status='terminal' ORDER BY id", (json.dumps(KIND),)
    )


def inventory(db, backup=None):
    protected = protected_tasks(db)
    stats = {"rows": 0, "original_record_bytes": 0, "replacement_record_bytes": 0}
    for row in candidates(db):
        if not eligible(db, row, protected):
            continue
        changed = replacement(row[6])
        stats["rows"] += 1
        stats["original_record_bytes"] += len(row[6].encode("utf-8"))
        stats["replacement_record_bytes"] += len(changed.encode("utf-8"))
        if backup is not None:
            after = (*row[:6], changed)
            backup.execute(
                "INSERT INTO before_images VALUES (?,?,?,?,?,?,?,?,?,?)",
                (*row, changed, row_hash(row), row_hash(after)),
            )
    return stats


def verify(backup, target):
    if backup.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
        raise ValueError("Backup integrity_check failed")
    manifest = json.loads(backup.execute("SELECT value FROM manifest").fetchone()[0])
    if manifest["format"] != 1 or manifest["database"] != str(Path(target).resolve()):
        raise ValueError("Backup target/format mismatch")
    stats = {"rows": 0, "original_record_bytes": 0, "replacement_record_bytes": 0}
    for saved in backup.execute(f"SELECT {COLUMNS}, replacement, original_sha256, replacement_sha256 FROM before_images ORDER BY id"):
        row, changed, before_hash, after_hash = saved[:7], saved[7], saved[8], saved[9]
        if row_hash(row) != before_hash or row_hash((*row[:6], changed)) != after_hash:
            raise ValueError(f"Backup hash mismatch for task {row[0]}")
        if replacement(row[6]) != changed:
            raise ValueError(f"Invalid replacement for task {row[0]}")
        stats["rows"] += 1
        stats["original_record_bytes"] += len(row[6].encode("utf-8"))
        stats["replacement_record_bytes"] += len(changed.encode("utf-8"))
    if stats != manifest["counts"]:
        raise ValueError("Backup manifest counts mismatch")
    return stats


def make_backup(target, destination):
    # Exclusive creation prevents accidental overwrite, including a live database.
    descriptor = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    source = connect(target)
    backup = sqlite3.connect(destination)
    try:
        source.execute("BEGIN")
        backup.executescript("""
            CREATE TABLE before_images (
                id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, kind TEXT NOT NULL,
                status TEXT NOT NULL, abort_requested INTEGER NOT NULL, background INTEGER NOT NULL,
                record TEXT NOT NULL, replacement TEXT NOT NULL,
                original_sha256 TEXT NOT NULL, replacement_sha256 TEXT NOT NULL
            );
            CREATE TABLE manifest (value TEXT NOT NULL);
        """)
        stats = inventory(source, backup)
        manifest = {"format": 1, "database": str(Path(target).resolve()), "counts": stats}
        backup.execute("INSERT INTO manifest VALUES (?)", (json.dumps(manifest),))
        backup.commit()
        verify(backup, target)
        return stats
    finally:
        source.close()
        backup.close()


def mutate(target, backup_path, restore=False, chunk_size=1):
    if chunk_size < 1:
        raise ValueError("chunk-size must be positive")
    backup = connect(backup_path)
    db = None
    try:
        verify(backup, target)  # Complete verification before the first live write.
        db = connect(target, writable=True)
        stats = {"updated": 0, "skipped": 0, "logical_bytes_removed": 0}
        cursor = backup.execute(f"SELECT {COLUMNS}, replacement FROM before_images ORDER BY id")
        while batch := cursor.fetchmany(chunk_size):
            db.execute("BEGIN IMMEDIATE")
            try:
                protected = protected_tasks(db) if not restore else None
                for saved in batch:
                    original, changed = saved[:7], saved[7]
                    current = db.execute(f"SELECT {COLUMNS} FROM tasks WHERE id=?", (saved[0],)).fetchone()
                    expected = (*original[:6], changed) if restore else original
                    if current != expected or (not restore and not eligible(db, current, protected)):
                        stats["skipped"] += 1
                        continue
                    db.execute("UPDATE tasks SET record=? WHERE id=? AND record=?",
                               (original[6] if restore else changed, saved[0], expected[6]))
                    stats["updated"] += 1
                    difference = len(original[6].encode("utf-8")) - len(changed.encode("utf-8"))
                    stats["logical_bytes_removed"] += -difference if restore else difference
                db.commit()
            except BaseException:
                db.rollback()
                raise
        return stats
    finally:
        backup.close()
        if db is not None:
            db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("plan", "backup", "apply", "restore"))
    parser.add_argument("--db", required=True, help="Concrete target runtime.sqlite path")
    parser.add_argument("--backup", help="Before-image SQLite file (new for backup)")
    parser.add_argument("--chunk-size", type=int, default=1)
    args = parser.parse_args()
    if args.action != "plan" and not args.backup:
        parser.error("--backup is required")
    if args.action == "plan":
        db = connect(args.db)
        try:
            db.execute("BEGIN")
            result = inventory(db)
        finally:
            db.close()
    elif args.action == "backup":
        result = make_backup(args.db, args.backup)
    else:
        result = mutate(args.db, args.backup, args.action == "restore", args.chunk_size)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
