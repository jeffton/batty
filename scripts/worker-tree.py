#!/usr/bin/env python3
"""Targeted before-image backup, offline deletion and restoration of a settled worker tree."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import sqlite3

# Pi Durable 1.4 / durable schema 2 and Batty's derived indexes. Session documents,
# record_ids, durable_metadata and all filesystem artifacts are deliberately absent.
COLUMNS = {
    "conversations": "id owner_conversation_id owner_task_id record",
    "entries": "id conversation_id head commit_seq record",
    "submissions": "id conversation_id request_id status record",
    "tasks": "id conversation_id kind status abort_requested background record",
    "documents": "id kind family key_value scope_kind owner_id created_at retired_at record",
    "document_revisions": "document_id seq kind version content",
    "batty_entry_visibility": "id conversation_id visible_count",
    "batty_message_counts": "conversation_id count",
    "batty_memory_search": "rowid text conversation original_id date kind",
    "batty_memory_search_cursor": "conversation next_id",
}
COLUMNS = {table: value.split() for table, value in COLUMNS.items()}
KEYS = {table: columns[:1] for table, columns in COLUMNS.items()}
KEYS["document_revisions"] = ["document_id", "seq"]
ORDER = list(COLUMNS)
ALLOWED_TABLES = set(ORDER) | {
    "durable_schema", "durable_metadata", "record_ids",
    *("batty_memory_search_" + suffix for suffix in ("data", "idx", "content", "docsize", "config")),
}


def quoted(value):
    return '"' + value.replace('"', '""') + '"'


def fields(table):
    return ",".join(map(quoted, COLUMNS[table]))


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def row_bytes(row):
    return canonical([{"blob": base64.b64encode(v).decode()} if isinstance(v, bytes) else v
                      for v in row]).encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def connect(path, writable=False):
    path = Path(path).resolve(strict=True)
    db = sqlite3.connect(path.as_uri() + ("?mode=rw" if writable else "?mode=ro"), uri=True)
    db.execute("PRAGMA busy_timeout=30000")
    db.execute("PRAGMA foreign_keys=ON")
    return db


def schema_hash(db):
    schema = db.execute(
        "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"
    ).fetchall()
    tables = {row[1] for row in schema if row[0] == "table"}
    if tables != ALLOWED_TABLES:
        raise ValueError(f"Unsupported tables: {sorted(tables ^ ALLOWED_TABLES)}")
    if db.execute("SELECT * FROM durable_schema").fetchall() != [(1, 2)]:
        raise ValueError("Unsupported durable schema")
    for table, columns in COLUMNS.items():
        actual = [row[1] for row in db.execute(f"PRAGMA table_info({quoted(table)})")]
        if actual != (columns[1:] if table == "batty_memory_search" else columns):
            raise ValueError(f"Unsupported columns: {table}")
    # Only the installed history INSERT trigger is supported. It is suspended
    # transactionally for restore so exact before-images, not recomputed counts, win.
    triggers = [row for row in schema if row[0] == "trigger"]
    if any(row[1:3] != ("batty_count_entry", "entries") or not
           " ".join(row[3].upper().split()).startswith(
               "CREATE TRIGGER BATTY_COUNT_ENTRY AFTER INSERT ON ENTRIES BEGIN "
           ) for row in triggers):
        raise ValueError("Unsupported trigger")
    return sha(row_bytes(schema))


def expected_members(root, expected):
    if not expected or any(type(v) is not int or v < 1 for v in expected):
        raise ValueError("Expected members must be positive integer IDs")
    if len(set(expected)) != len(expected) or root not in expected:
        raise ValueError("Expected members must be unique and include root")
    return sorted(expected)


def prepare(db, root, expected):
    expected = expected_members(root, expected)
    actual = sorted(row[0] for row in db.execute("""
        WITH RECURSIVE tree(id) AS (
          SELECT id FROM conversations WHERE id=?
          UNION SELECT c.id FROM conversations c JOIN tree t ON c.owner_conversation_id=t.id
        ) SELECT id FROM tree
    """, (root,)))
    if actual != expected:
        raise ValueError(f"Tree membership changed: {actual}")
    scopes(db, expected)
    return actual


def scopes(db, members, task_ids=None, document_ids=None):
    for name in ("members", "selected_tasks", "selected_documents"):
        db.execute(f"DROP TABLE IF EXISTS temp.{name}")
        db.execute(f"CREATE TEMP TABLE {name} (id INTEGER PRIMARY KEY)")
    db.executemany("INSERT INTO members VALUES (?)", ((v,) for v in members))
    if task_ids is None:
        db.execute("INSERT INTO selected_tasks SELECT id FROM tasks WHERE conversation_id IN members")
    else:
        db.executemany("INSERT INTO selected_tasks VALUES (?)", ((v,) for v in task_ids))
    if document_ids is None:
        db.execute("""INSERT INTO selected_documents SELECT id FROM documents WHERE
            (scope_kind='conversation' AND owner_id IN members) OR
            (scope_kind='task' AND owner_id IN selected_tasks)""")
    else:
        db.executemany("INSERT INTO selected_documents VALUES (?)", ((v,) for v in document_ids))


def condition(table):
    if table == "conversations":
        return "id IN members"
    if table == "documents":
        return "(scope_kind='conversation' AND owner_id IN members) OR (scope_kind='task' AND owner_id IN selected_tasks)"
    if table == "document_revisions":
        return "document_id IN selected_documents"
    if table in ("batty_memory_search", "batty_memory_search_cursor"):
        return "conversation IN members"
    return "conversation_id IN members"


def rows(db, table, backup=False):
    source = "b_" + table if backup else table
    where = "" if backup else " WHERE " + condition(table)
    order = ",".join(map(quoted, KEYS[table]))
    return db.execute(f"SELECT {fields(table)} FROM {quoted(source)}{where} ORDER BY {order}")


def summarize(db, backup=False, destination=None):
    result = {}
    for table in ORDER:
        digest = hashlib.sha256()
        count = 0
        for row in rows(db, table, backup):
            digest.update(hashlib.sha256(row_bytes(row)).digest())
            count += 1
            if destination is not None:
                destination.execute(
                    f"INSERT INTO {quoted('b_' + table)} VALUES ({','.join('?' for _ in row)})", row
                )
        result[table] = {"rows": count, "sha256": digest.hexdigest()}
    return result


def references(value):
    """Conservative exact ID values, not digits embedded in prose or shell commands."""
    if type(value) is int:
        yield value
    elif isinstance(value, str) and value.isascii() and value.isdecimal():
        yield int(value)
    elif isinstance(value, list):
        for item in value:
            yield from references(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            yield from references(key)
            yield from references(item)


def protected(db, forbidden):
    """Follow durable ownership/wait/replay links, never arbitrary history payloads.

    Terminal outcomes are immutable receipts, not runnable checkpoints. Only their
    ownership and original inputs are followed; entry/model/memory bodies are not.
    """
    pending = []
    def enqueue(refs):
        # Follow scheduler links and referenced records' ownership metadata only.
        # Never load historical entry/model/memory or terminal result payloads.
        for ref in refs:
            record_type = db.execute("SELECT record_type FROM record_ids WHERE id=?", (ref,)).fetchone()
            if record_type is None:
                continue
            if record_type[0] in ("task", "conversation"):
                pending.append((record_type[0], ref))
            elif record_type[0] in ("entry", "submission"):
                table = "entries" if record_type[0] == "entry" else "submissions"
                owner = db.execute(f"SELECT conversation_id FROM {table} WHERE id=?", (ref,)).fetchone()
                if owner:
                    pending.append(("conversation", owner[0]))
            elif record_type[0] == "document":
                owner = db.execute("SELECT scope_kind,owner_id FROM documents WHERE id=?", (ref,)).fetchone()
                if owner and owner[0] != "session":
                    pending.append(owner)

    for identity, raw in db.execute("SELECT id,record FROM tasks WHERE status!='terminal'"):
        refs = set(references(json.loads(raw)))
        if refs & forbidden:
            raise ValueError(f"Active task record references tree: {identity}")
        enqueue(refs)
        pending.append(("task", identity))
    for identity, conversation, raw in db.execute(
        "SELECT id,conversation_id,record FROM submissions WHERE status IN ('queued','placed')"
    ):
        refs = set(references(json.loads(raw)))
        if {identity, conversation} & forbidden or refs & forbidden:
            raise ValueError(f"Live submission references tree: {identity}")
        enqueue(refs)
        pending.append(("conversation", conversation))
    seen = set()
    while pending:
        kind, identity = pending.pop()
        if (kind, identity) in seen:
            continue
        seen.add((kind, identity))
        if len(seen) > 100000:
            raise ValueError("Replay graph exceeds inspection bound")
        if identity in forbidden:
            raise ValueError(f"Live replay/ownership chain references tree: {kind} {identity}")
        if kind == "conversation":
            row = db.execute("SELECT owner_conversation_id,owner_task_id FROM conversations WHERE id=?",
                             (identity,)).fetchone()
            if row:
                pending.extend((k, v) for k, v in zip(("conversation", "task"), row) if v is not None)
            continue
        row = db.execute("""SELECT conversation_id,status,json_extract(record,'$.owner'),
            json_extract(record,'$.input'),json_extract(record,'$.state.checkpoint'),
            json_extract(record,'$.state.on'),json_extract(record,'$.memos') FROM tasks WHERE id=?""",
                         (identity,)).fetchone()
        if row is None:
            continue
        conversation, status, owner, *parts = row
        pending.append(("conversation", conversation))
        if owner is not None:
            pending.append(("task", owner))
        refs = set()
        for part in parts:
            # json_extract returns bare SQL scalar values for scalar JSON inputs.
            if isinstance(part, str):
                try:
                    part = json.loads(part)
                except json.JSONDecodeError:
                    pass
            refs.update(references(part))
        if refs & forbidden:
            raise ValueError(f"Replay input/checkpoint references tree: task {identity}")
        enqueue(refs)


def latest_base(db, document):
    base = db.execute("""SELECT seq,version,content FROM document_revisions
        WHERE document_id=? AND kind='base' ORDER BY seq DESC LIMIT 1""", (document,)).fetchone()
    if base is None or base[1] != 1:
        raise ValueError(f"Missing/unsupported document base: {document}")
    return base[0], json.loads(base[2])


def worker_parent(db, document):
    seq, value = latest_base(db, document)
    # Project only lifecycle identity; do not deserialize retained report payloads.
    parent = value.get("parentId")
    worker = value.get("isSubagent")
    for raw, in db.execute("""SELECT op.value FROM document_revisions r,json_each(r.content) op
        WHERE r.document_id=? AND r.seq>? AND
          (json_extract(op.value,'$[0]')='r' OR
           json_extract(op.value,'$[1][0]') IN ('parentId','isSubagent'))
        ORDER BY r.seq,CAST(op.key AS INTEGER)""", (document, seq)):
        op = json.loads(raw)
        if op[0] == "r":
            parent, worker = op[1].get("parentId"), op[1].get("isSubagent")
        elif len(op[1]) != 1 or op[0] not in ("s", "d"):
            raise ValueError(f"Unsupported worker identity delta: {document}")
        elif op[1][0] == "parentId":
            parent = op[2] if op[0] == "s" else None
        else:
            worker = op[2] if op[0] == "s" else None
    return parent, worker


def settled_owners(db):
    owners = [row[0] for row in db.execute("""SELECT owner_task_id FROM conversations
        WHERE id IN members AND owner_task_id IS NOT NULL
        UNION SELECT json_extract(record,'$.owner') FROM tasks
        WHERE conversation_id IN members AND json_extract(record,'$.owner') IS NOT NULL""")]
    settled = set()
    for identity in owners:
        chain = set()
        while identity is not None and identity not in settled:
            if identity in chain:
                raise ValueError("Task ownership cycle")
            chain.add(identity)
            row = db.execute("SELECT status,json_extract(record,'$.owner') FROM tasks WHERE id=?",
                             (identity,)).fetchone()
            if row is None or row[0] != "terminal":
                raise ValueError(f"Unsettled/missing owning task: {identity}")
            identity = row[1]
        settled.update(chain)


def eligibility(db):
    settled_owners(db)
    external_head = db.execute("""SELECT id FROM entries WHERE head IS NOT NULL
        AND conversation_id NOT IN members AND head IN
          (SELECT id FROM entries WHERE conversation_id IN members) LIMIT 1""").fetchone()
    if external_head:
        raise ValueError(f"External history head references tree: entry {external_head[0]}")
    for table in ("tasks", "submissions"):
        allowed = "status='terminal'" if table == "tasks" else "status IN ('done','unanswered')"
        if db.execute(f"SELECT 1 FROM {table} WHERE conversation_id IN members AND NOT ({allowed}) LIMIT 1").fetchone():
            raise ValueError(f"Unsettled {table} in tree")
    for identity, parent in db.execute("SELECT id,owner_conversation_id FROM conversations WHERE id IN members"):
        for kind in ("batty.worker", "pi.live", "pi.inbox"):
            docs = db.execute("""SELECT id FROM documents WHERE scope_kind='conversation'
                AND owner_id=? AND kind=? AND retired_at IS NULL""", (identity, json.dumps(kind))).fetchall()
            if len(docs) != 1:
                raise ValueError(f"Expected one active {kind} document: {identity}")
            document = docs[0][0]
            if kind == "batty.worker":
                if parent is None or worker_parent(db, document) != (parent, True):
                    raise ValueError(f"Worker parent mismatch/not worker: {identity}")
            else:
                seq, base = latest_base(db, document)
                if db.execute("SELECT 1 FROM document_revisions WHERE document_id=? AND seq>? LIMIT 1",
                              (document, seq)).fetchone():
                    raise ValueError(f"Uncheckpointed {kind}: {identity}")
                idle = base == {} if kind == "pi.live" else base == {"items": []}
                if not idle:
                    raise ValueError(f"Non-idle {kind}: {identity}")
    forbidden = set()
    for table in ("conversations", "entries", "submissions", "tasks", "documents"):
        forbidden.update(row[0] for row in db.execute(f"SELECT id FROM {table} WHERE {condition(table)}"))
    protected(db, forbidden)


def identities(db):
    result = []
    for table, kind in (("conversations", "conversation"), ("entries", "entry"),
                        ("submissions", "submission"), ("tasks", "task"), ("documents", "document")):
        for identity, in db.execute(f"SELECT id FROM {table} WHERE {condition(table)} ORDER BY id"):
            if db.execute("SELECT record_type FROM record_ids WHERE id=?", (identity,)).fetchone() != (kind,):
                raise ValueError(f"Missing/mismatched identity tombstone: {identity}")
            result.append([identity, kind])
    return sorted(result)


def check_identities(db, saved):
    for identity, kind in saved:
        if db.execute("SELECT record_type FROM record_ids WHERE id=?", (identity,)).fetchone() != (kind,):
            raise ValueError(f"Identity tombstone changed: {identity}")


def source_identity(path):
    stat = Path(path).stat()
    return [stat.st_dev, stat.st_ino]


def make_backup(target, destination, root, expected):
    descriptor = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    source, backup = connect(target), sqlite3.connect(destination)
    try:
        source.execute("BEGIN")
        schema = schema_hash(source)
        members = prepare(source, root, expected)
        eligibility(source)
        backup.execute("CREATE TABLE manifest (value TEXT NOT NULL, sha256 TEXT NOT NULL)")
        for table, columns in COLUMNS.items():
            names = ",".join(map(quoted, columns))
            keys = ",".join(map(quoted, KEYS[table]))
            backup.execute(f"CREATE TABLE {quoted('b_' + table)} ({names}, PRIMARY KEY ({keys}))")
        counts = summarize(source, destination=backup)
        manifest = {"format": 1, "database": str(Path(target).resolve()),
                    "identity": source_identity(target), "schema_sha256": schema,
                    "root": root, "members": members, "columns": COLUMNS, "keys": KEYS,
                    "identities": identities(source), "tables": counts}
        raw = canonical(manifest)
        backup.execute("INSERT INTO manifest VALUES (?,?)", (raw, sha(raw.encode())))
        backup.commit()
        verify(backup, target, root, expected)
        return counts
    finally:
        source.close()
        backup.close()


def verify(backup, target, root, expected):
    if backup.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
        raise ValueError("Backup integrity_check failed")
    manifests = backup.execute("SELECT value,sha256 FROM manifest").fetchall()
    if len(manifests) != 1 or sha(manifests[0][0].encode()) != manifests[0][1]:
        raise ValueError("Manifest hash mismatch")
    saved = json.loads(manifests[0][0])
    if (saved["format"] != 1 or saved["database"] != str(Path(target).resolve())
            or saved["root"] != root or saved["members"] != expected_members(root, expected)
            or saved["columns"] != COLUMNS or saved["keys"] != KEYS):
        raise ValueError("Backup target/membership/format mismatch")
    if summarize(backup, backup=True) != saved["tables"]:
        raise ValueError("Backup row hash/count mismatch")
    members = sorted(row[0] for row in rows(backup, "conversations", backup=True))
    if members != saved["members"]:
        raise ValueError("Backup conversation membership mismatch")
    return saved


def mutate(target, backup_path, root, expected, restore=False, quiesced=False):
    if not quiesced:
        raise ValueError("Stop the runtime and explicitly pass --quiesced")
    backup, db = connect(backup_path), None
    try:
        saved = verify(backup, target, root, expected)
        db = connect(target, writable=True)
        db.execute("BEGIN IMMEDIATE")
        if source_identity(target) != saved["identity"] or schema_hash(db) != saved["schema_sha256"]:
            raise ValueError("Source identity/schema changed")
        check_identities(db, saved["identities"])
        if not restore:
            prepare(db, root, expected)
            eligibility(db)
            if identities(db) != saved["identities"] or summarize(db) != saved["tables"]:
                raise ValueError("Original rows changed since backup")
            for table in reversed(ORDER):
                db.execute(f"DELETE FROM {quoted(table)} WHERE {condition(table)}")
        else:
            task_ids = [row[0] for row in rows(backup, "tasks", backup=True)]
            document_ids = [row[0] for row in rows(backup, "documents", backup=True)]
            scopes(db, saved["members"], task_ids, document_ids)
            # Catch newly created children, scoped rows and primary-key collisions,
            # including a formerly deleted ID reused under a different conversation.
            if db.execute("SELECT 1 FROM conversations WHERE owner_conversation_id IN members LIMIT 1").fetchone():
                raise ValueError("New child conversation prevents restore")
            for table in ORDER:
                if db.execute(f"SELECT 1 FROM {quoted(table)} WHERE {condition(table)} LIMIT 1").fetchone():
                    raise ValueError(f"Restore scope is not empty: {table}")
                for row in rows(backup, table, backup=True):
                    key_values = [row[COLUMNS[table].index(key)] for key in KEYS[table]]
                    where = " AND ".join(quoted(key) + "=?" for key in KEYS[table])
                    if db.execute(f"SELECT 1 FROM {quoted(table)} WHERE {where}", key_values).fetchone():
                        raise ValueError(f"Restore key collision: {table} {key_values}")
            for row in rows(backup, "documents", backup=True):
                address = (row[1], row[4], row[5], row[2], row[3])
                if db.execute("""SELECT 1 FROM documents WHERE kind=? AND scope_kind=?
                    AND owner_id=? AND family=? AND key_value=? LIMIT 1""", address).fetchone():
                    raise ValueError(f"Restore document address collision: {address}")
            trigger = db.execute("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='batty_count_entry'").fetchone()
            if trigger:
                db.execute("DROP TRIGGER batty_count_entry")
            for table in ORDER:
                for row in rows(backup, table, backup=True):
                    db.execute(f"INSERT INTO {quoted(table)} ({fields(table)}) VALUES ({','.join('?' for _ in row)})", row)
            if trigger:
                db.execute(trigger[0])
            prepare(db, root, expected)
            if summarize(db) != saved["tables"]:
                raise ValueError("Restored rows differ from before-images")
        db.commit()
        return {"restored" if restore else "deleted": saved["tables"]}
    except BaseException:
        if db is not None:
            db.rollback()
        raise
    finally:
        backup.close()
        if db is not None:
            db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("plan", "backup", "verify", "apply", "restore"))
    parser.add_argument("--db", required=True)
    parser.add_argument("--root", type=int, required=True)
    parser.add_argument("--expected-members", required=True, help="JSON file containing the exact integer ID list")
    parser.add_argument("--backup", help="Before-image SQLite file; must not exist for backup")
    parser.add_argument("--quiesced", action="store_true", help="Confirm runtime is stopped (required for writes)")
    args = parser.parse_args()
    expected = json.loads(Path(args.expected_members).read_text())
    if args.action != "plan" and not args.backup:
        parser.error("--backup is required")
    if args.action == "plan":
        with connect(args.db) as db:
            db.execute("BEGIN")
            schema_hash(db)
            prepare(db, args.root, expected)
            eligibility(db)
            result = {table: {"rows": db.execute(
                f"SELECT count(*) FROM {quoted(table)} WHERE {condition(table)}"
            ).fetchone()[0]} for table in ORDER}
    elif args.action == "backup":
        result = make_backup(args.db, args.backup, args.root, expected)
    elif args.action == "verify":
        with connect(args.backup) as db:
            result = verify(db, args.db, args.root, expected)["tables"]
    else:
        result = mutate(args.db, args.backup, args.root, expected,
                        restore=args.action == "restore", quiesced=args.quiesced)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
