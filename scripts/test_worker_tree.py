#!/usr/bin/env python3
"""Fixture-only worker-tree maintenance tests; never opens installation data."""

import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("worker_tree", Path(__file__).with_name("worker-tree.py"))
tree = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tree)

SCHEMA = """
CREATE TABLE durable_schema (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL) STRICT;
INSERT INTO durable_schema VALUES (1,2);
CREATE TABLE durable_metadata (singleton INTEGER PRIMARY KEY,next_id TEXT NOT NULL,next_seq INTEGER NOT NULL) STRICT;
INSERT INTO durable_metadata VALUES (1,'9000',9000);
CREATE TABLE record_ids (id INTEGER PRIMARY KEY,record_type TEXT NOT NULL) STRICT;
CREATE TABLE conversations (id INTEGER PRIMARY KEY,owner_conversation_id INTEGER,owner_task_id INTEGER,record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
CREATE TABLE entries (id INTEGER PRIMARY KEY,conversation_id INTEGER NOT NULL,head INTEGER,commit_seq INTEGER NOT NULL,record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
CREATE TABLE submissions (id INTEGER PRIMARY KEY,conversation_id INTEGER NOT NULL,request_id TEXT,status TEXT NOT NULL CHECK(status IN ('queued','placed','done','unanswered')),record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
CREATE TABLE tasks (id INTEGER PRIMARY KEY,conversation_id INTEGER NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','running','waiting','sleeping','completing','terminal')),abort_requested INTEGER NOT NULL,background INTEGER NOT NULL,record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
CREATE INDEX tasks_by_status ON tasks(status,id);
CREATE INDEX tasks_by_conversation ON tasks(conversation_id,id);
CREATE TABLE documents (id INTEGER PRIMARY KEY,kind TEXT NOT NULL,family INTEGER NOT NULL,key_value TEXT NOT NULL,scope_kind TEXT NOT NULL CHECK(scope_kind IN ('session','conversation','task')),owner_id INTEGER NOT NULL,created_at INTEGER NOT NULL,retired_at INTEGER,record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
CREATE INDEX documents_by_scope ON documents(scope_kind,owner_id,id);
CREATE TABLE document_revisions (document_id INTEGER NOT NULL,seq INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('base','delta')),version INTEGER NOT NULL,content TEXT NOT NULL CHECK(json_valid(content)),PRIMARY KEY(document_id,seq)) STRICT;
CREATE TABLE batty_entry_visibility (id INTEGER PRIMARY KEY,conversation_id INTEGER NOT NULL,visible_count INTEGER NOT NULL) STRICT;
CREATE TABLE batty_message_counts (conversation_id INTEGER PRIMARY KEY,count INTEGER NOT NULL) STRICT;
CREATE TRIGGER batty_count_entry AFTER INSERT ON entries BEGIN
  INSERT INTO batty_entry_visibility VALUES(new.id,new.conversation_id,1);
  INSERT INTO batty_message_counts VALUES(new.conversation_id,1)
    ON CONFLICT(conversation_id) DO UPDATE SET count=count+1;
END;
CREATE VIRTUAL TABLE batty_memory_search USING fts5(text,conversation UNINDEXED,original_id UNINDEXED,date UNINDEXED,kind UNINDEXED,tokenize='unicode61 remove_diacritics 2');
CREATE TABLE batty_memory_search_cursor (conversation INTEGER PRIMARY KEY,next_id INTEGER NOT NULL) STRICT;
"""


class WorkerTreeTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.target = Path(directory.name) / "runtime.sqlite"
        self.backup = Path(directory.name) / "before.sqlite"
        self.db = sqlite3.connect(self.target)
        self.addCleanup(self.db.close)
        self.db.executescript(SCHEMA)
        self.next_doc = 1000
        self.conversation(1)
        self.conversation(10, parent=1, owner=90)
        self.conversation(20, parent=10, owner=100)
        self.task(90, conversation=1, kind="batty.worker-anchor")
        self.task(91, conversation=1, kind="batty.delivery", input={"childId": 10})
        self.task(100, conversation=10)
        self.task(200, conversation=20, owner=100)
        for conversation in (1, 10, 20):
            self.document("batty.worker", conversation, {
                "isSubagent": conversation != 1,
                **({"parentId": 1 if conversation == 10 else 10} if conversation != 1 else {}),
            })
            self.document("pi.live", conversation, {})
            self.document("pi.inbox", conversation, {"items": []})
            self.document("batty.worker-memory", conversation, {"precious": "OptChat"})
        # Session registry and result references deliberately outlive deleted rows.
        self.registry = self.document("batty.orchestration", 1, {
            "workers": {"10": {"parentId": 1, "conversationId": 10, "taskId": 91}},
            "artifacts": ["attachment://keep", "site:keep"],
        }, scope="session")
        self.document("batty.delivery-record", 1, {"taskId": 91, "childId": 10}, scope="session")
        self.document("task.memo", 100, {"payload": "large" * 1000}, scope="task")
        self.document("task.memo", 91, {"artifact": "keep"}, scope="task")
        for identity, conversation in ((2, 1), (110, 10), (210, 20)):
            self.entry(identity, conversation)
        self.submission(130, 10)
        self.submission(230, 20)
        self.db.execute("INSERT INTO batty_memory_search VALUES ('main memory',1,2,'date','talk')")
        self.db.execute("INSERT INTO batty_memory_search VALUES ('worker memory',10,110,'date','talk')")
        self.db.executemany("INSERT INTO batty_memory_search_cursor VALUES (?,?)", [(1, 2), (10, 110)])
        self.db.commit()
        self.members = [10, 20]

    def claim(self, identity, kind):
        self.db.execute("INSERT INTO record_ids VALUES (?,?)", (identity, kind))

    def conversation(self, identity, parent=None, owner=None):
        self.claim(identity, "conversation")
        self.db.execute("INSERT INTO conversations VALUES (?,?,?,?)", (
            identity, parent, owner, json.dumps({"id": identity, "owner": {"conversationId": parent, "taskId": owner}})))

    def task(self, identity, conversation=1, status="terminal", kind="pi.tool", owner=None,
             input=None, state=None):
        self.claim(identity, "task")
        record = {"id": identity, "conversationId": conversation, "kind": kind, "version": 1,
                  "input": input or {}, "background": False, "abortRequested": False,
                  "state": state or {"status": status, **(
                      {"outcome": {"status": "completed", "result": "receipt"}}
                      if status in ("terminal", "completing") else {"checkpoint": {"phase": "run"}})}}
        if owner is not None:
            record["owner"] = owner
        self.db.execute("INSERT INTO tasks VALUES (?,?,?,?,?,?,?)", (
            identity, conversation, json.dumps(kind), status, 0, 0, json.dumps(record)))

    def document(self, kind, owner, value, scope="conversation", retired=None):
        identity = self.next_doc
        self.next_doc += 1
        self.claim(identity, "document")
        self.db.execute("INSERT INTO documents VALUES (?,?,0,'',?,?,1,?,?)", (
            identity, json.dumps(kind), scope, owner, retired, json.dumps({"id": identity, "kind": kind})))
        self.db.execute("INSERT INTO document_revisions VALUES (?,1,'base',1,?)", (identity, json.dumps(value)))
        return identity

    def entry(self, identity, conversation):
        self.claim(identity, "entry")
        self.db.execute("INSERT INTO entries VALUES (?,?,NULL,1,?)", (
            identity, conversation, json.dumps({"id": identity, "data": {"text": "keep exact"}})))

    def submission(self, identity, conversation, status="done", extra=None):
        self.claim(identity, "submission")
        self.db.execute("INSERT INTO submissions VALUES (?,?,NULL,?,?)", (
            identity, conversation, status, json.dumps({"id": identity, "conversationId": conversation, **(extra or {})})))

    def backup_now(self):
        self.db.commit()
        return tree.make_backup(self.target, self.backup, 10, self.members)

    def apply(self, restore=False):
        return tree.mutate(self.target, self.backup, 10, self.members, restore=restore, quiesced=True)

    def snapshot(self):
        result = {}
        for name, in self.db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
            if name.startswith("batty_memory_search_") and name != "batty_memory_search_cursor":
                continue  # FTS internal page layout is derived; compare logical rows instead.
            result[name] = self.db.execute(f'SELECT * FROM "{name}" ORDER BY 1').fetchall()
        result["schema"] = self.db.execute("SELECT * FROM sqlite_master ORDER BY type,name").fetchall()
        return result

    def test_backup_apply_restore_isolation_and_history_trigger(self):
        # Retired docs and every revision are before-imaged too.
        doc = self.document("retired", 10, {"image": "base64"}, retired=2)
        self.db.execute("INSERT INTO document_revisions VALUES (?,2,'delta',1,?)", (doc, '[["s",["flag"],true]]'))
        self.db.commit()
        original = self.snapshot()
        stats = self.backup_now()
        self.assertEqual(stats["conversations"]["rows"], 2)
        self.assertEqual(stats["tasks"]["rows"], 2)
        self.assertEqual(self.backup.stat().st_mode & 0o777, 0o600)
        self.apply()
        self.assertEqual(self.db.execute("SELECT id FROM conversations").fetchall(), [(1,)])
        self.assertEqual(self.db.execute("SELECT id FROM tasks").fetchall(), [(90,), (91,)])
        self.assertEqual(self.db.execute("SELECT text FROM batty_memory_search").fetchall(), [("main memory",)])
        self.assertEqual(self.db.execute("SELECT * FROM record_ids").fetchall(), original["record_ids"])
        self.assertEqual(self.db.execute("SELECT * FROM durable_metadata").fetchall(), original["durable_metadata"])
        self.assertEqual(self.db.execute("SELECT record FROM documents WHERE id=?", (self.registry,)).fetchone(),
                         (next(row[-1] for row in original["documents"] if row[0] == self.registry),))
        with self.assertRaises(ValueError):
            self.apply()  # Not a silent idempotent skip.
        self.apply(restore=True)
        self.assertEqual(self.snapshot(), original)
        with self.assertRaisesRegex(ValueError, "not empty|New child"):
            self.apply(restore=True)

    def test_exact_membership_and_nonworker(self):
        with self.assertRaisesRegex(ValueError, "membership"):
            tree.make_backup(self.target, self.backup, 10, [10])
        other = self.backup.with_name("main.sqlite")
        with self.assertRaisesRegex(ValueError, "not worker"):
            tree.make_backup(self.target, other, 1, [1, 10, 20])

    def test_active_target_and_queued_submission_block(self):
        for table in ("tasks", "submissions"):
            with self.subTest(table=table):
                self.db.execute("SAVEPOINT scenario")
                if table == "tasks":
                    self.task(300, conversation=20, status="sleeping")
                else:
                    self.submission(300, 20, status="queued")
                tree.scopes(self.db, self.members)
                with self.assertRaisesRegex(ValueError, "Unsettled"):
                    tree.eligibility(self.db)
                self.db.execute("ROLLBACK TO scenario")
                self.db.execute("RELEASE scenario")

    def test_external_fork_history_head_blocks_without_payload_reads(self):
        self.entry(400, 1)
        self.db.execute("UPDATE entries SET head=110 WHERE id=400")
        self.db.commit()
        original = self.snapshot()
        with self.assertRaisesRegex(ValueError, "External history head"):
            self.backup_now()
        self.assertEqual(self.snapshot(), original)

    def test_live_owning_task_without_explicit_child_reference_blocks(self):
        self.task(500, status="running")
        raw = json.loads(self.db.execute("SELECT record FROM tasks WHERE id=100").fetchone()[0])
        raw["owner"] = 500
        self.db.execute("UPDATE tasks SET record=? WHERE id=100", (json.dumps(raw),))
        self.db.commit()
        with self.assertRaisesRegex(ValueError, "owning task"):
            self.backup_now()

    def test_external_active_replay_references(self):
        cases = [
            ("batty.delivery", {"childId": 10}),
            ("batty.await-child", {"target": 100}),
            ("node-command", {"args": {"sessionId": "20"}}),
            ("pi.tool", {"entry": 110}),
            ("pi.tool", {"document": 1004}),
            ("pi.tool", {"submission": 230}),
        ]
        for kind, input in cases:
            with self.subTest(kind=kind, input=input):
                self.db.execute("SAVEPOINT scenario")
                self.task(500, status="waiting", kind=kind, input=input)
                tree.scopes(self.db, self.members)
                with self.assertRaisesRegex(ValueError, "references tree"):
                    tree.eligibility(self.db)
                self.db.execute("ROLLBACK TO scenario")
                self.db.execute("RELEASE scenario")

    def test_owner_wait_and_terminal_delivery_chain(self):
        for mode in ("owner", "wait", "terminal-input", "conversation-owner"):
            with self.subTest(mode=mode):
                self.db.execute("SAVEPOINT scenario")
                if mode == "owner":
                    self.task(500, status="running", owner=100)
                elif mode == "wait":
                    self.task(500, status="waiting", state={"status": "waiting", "on": [100], "checkpoint": {}})
                elif mode == "terminal-input":
                    self.task(501, input={"previous": 91})
                    self.task(500, status="waiting", input={"target": 501})
                else:
                    self.conversation(30, parent=1, owner=200)
                    self.task(500, conversation=30, status="running")
                tree.scopes(self.db, self.members)
                with self.assertRaisesRegex(ValueError, "references tree"):
                    tree.eligibility(self.db)
                self.db.execute("ROLLBACK TO scenario")
                self.db.execute("RELEASE scenario")

    def test_completing_outcome_and_active_memos(self):
        for part in ("outcome", "memos"):
            with self.subTest(part=part):
                self.db.execute("SAVEPOINT scenario")
                self.task(500, status="completing" if part == "outcome" else "running")
                raw = json.loads(self.db.execute("SELECT record FROM tasks WHERE id=500").fetchone()[0])
                if part == "outcome":
                    raw["state"]["outcome"]["result"] = {"childId": 20}
                else:
                    raw["memos"] = {"target": 100}
                self.db.execute("UPDATE tasks SET record=? WHERE id=500", (json.dumps(raw),))
                tree.scopes(self.db, self.members)
                with self.assertRaisesRegex(ValueError, "references tree"):
                    tree.eligibility(self.db)
                self.db.execute("ROLLBACK TO scenario")
                self.db.execute("RELEASE scenario")

    def test_resume_after_backup_is_atomic_rejection(self):
        self.backup_now()
        self.task(500, status="pending", input={"childId": 20})
        self.db.commit()
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "references tree"):
            self.apply()
        self.assertEqual(self.snapshot(), before)

    def test_membership_and_original_row_race(self):
        self.backup_now()
        self.db.execute("UPDATE entries SET record=? WHERE id=210", ('{"changed":true}',))
        self.db.commit()
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "Original rows changed"):
            self.apply()
        self.assertEqual(self.snapshot(), before)
        self.conversation(30, parent=20)
        self.db.commit()
        with self.assertRaisesRegex(ValueError, "membership"):
            self.apply()
        self.assertEqual(self.db.execute("SELECT count(*) FROM entries").fetchone(), (3,))

    def test_restore_new_rows_and_reused_id_are_not_overwritten(self):
        self.backup_now()
        self.apply()
        # The historical task identity remains claimed, but an SDK upsert can reuse it.
        self.db.execute("INSERT INTO tasks VALUES (100,1,'\"pi.tool\"','terminal',0,0,'{}')")
        self.db.commit()
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "key collision"):
            self.apply(restore=True)
        self.assertEqual(self.snapshot(), before)

    def test_restore_replacement_scoped_document_blocked(self):
        self.backup_now()
        self.apply()
        self.document("batty.worker", 10, {"replacement": True})
        self.db.commit()
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "not empty"):
            self.apply(restore=True)
        self.assertEqual(self.snapshot(), before)

    def test_atomic_rollback_on_mid_delete_and_restore_error(self):
        self.backup_now()
        original = self.snapshot()
        original_connect = tree.connect

        def deny(operation, table):
            def connect(path, writable=False):
                db = original_connect(path, writable)
                if writable:
                    db.set_authorizer(lambda op, arg, *_: sqlite3.SQLITE_DENY
                                      if op == operation and arg == table else sqlite3.SQLITE_OK)
                return db
            return connect

        with patch.object(tree, "connect", deny(sqlite3.SQLITE_DELETE, "entries")):
            with self.assertRaises(sqlite3.DatabaseError):
                self.apply()
        self.assertEqual(self.snapshot(), original)
        self.apply()
        deleted = self.snapshot()
        with patch.object(tree, "connect", deny(sqlite3.SQLITE_INSERT, "document_revisions")):
            with self.assertRaises(sqlite3.DatabaseError):
                self.apply(restore=True)
        self.assertEqual(self.snapshot(), deleted)
        self.apply(restore=True)
        self.assertEqual(self.snapshot(), original)

    def test_identity_tombstones_and_extra_scope_rows_revalidated(self):
        self.backup_now()
        self.db.execute("UPDATE record_ids SET record_type='entry' WHERE id=100")
        self.db.commit()
        with self.assertRaisesRegex(ValueError, "tombstone changed"):
            self.apply()
        self.db.execute("UPDATE record_ids SET record_type='task' WHERE id=100")
        self.document("new-task-document", 100, {"new": True}, scope="task")
        self.db.commit()
        with self.assertRaisesRegex(ValueError, "Original rows changed"):
            self.apply()

    def test_pending_external_submission_and_metadata_owner(self):
        self.submission(500, 1, status="queued", extra={"target": 20})
        self.db.commit()
        with self.assertRaisesRegex(ValueError, "Live submission references tree"):
            self.backup_now()

    def test_tombstone_changes_and_tampered_backup_block(self):
        self.backup_now()
        original = self.snapshot()
        with sqlite3.connect(self.backup) as db:
            db.execute("UPDATE b_entries SET record='{}' WHERE id=110")
        with self.assertRaisesRegex(ValueError, "hash/count"):
            self.apply()
        self.assertEqual(self.snapshot(), original)

    def test_backup_manifest_and_exclusive_creation(self):
        self.backup_now()
        with self.assertRaises(FileExistsError):
            self.backup_now()
        with sqlite3.connect(self.backup) as db:
            db.execute("UPDATE manifest SET sha256='bad'")
        with self.assertRaisesRegex(ValueError, "Manifest hash"):
            self.apply()

    def test_worker_parent_and_idle_checkpoints(self):
        for kind, value in (("batty.worker", {"parentId": 999, "isSubagent": True}),
                            ("pi.live", {"run": {"taskId": 100}}),
                            ("pi.inbox", {"items": [{"id": 130}]})):
            with self.subTest(kind=kind):
                self.db.execute("SAVEPOINT scenario")
                self.db.execute("""UPDATE document_revisions SET content=? WHERE document_id=(
                    SELECT id FROM documents WHERE owner_id=10 AND scope_kind='conversation' AND kind=?)""",
                                (json.dumps(value), json.dumps(kind)))
                tree.scopes(self.db, self.members)
                with self.assertRaises(ValueError):
                    tree.eligibility(self.db)
                self.db.execute("ROLLBACK TO scenario")
                self.db.execute("RELEASE scenario")

    def test_worker_parent_delta_projection(self):
        identity = self.db.execute("SELECT id FROM documents WHERE owner_id=10 AND kind='\"batty.worker\"'").fetchone()[0]
        self.db.execute("INSERT INTO document_revisions VALUES (?,2,'delta',1,?)", (
            identity, '[["s",["completion"],{"owner":91}],["s",["parentId"],1]]'))
        self.db.execute("INSERT INTO document_revisions VALUES (?,3,'delta',1,?)", (
            identity, '[["d",["completion"]]]'))
        self.backup_now()
        self.apply()
        self.apply(restore=True)
        self.assertEqual(tree.worker_parent(self.db, identity), (1, True))

    def test_unknown_trigger_and_schema_changes_rejected(self):
        self.backup_now()
        self.db.execute("CREATE TRIGGER surprise AFTER DELETE ON tasks BEGIN DELETE FROM entries; END")
        self.db.commit()
        with self.assertRaisesRegex(ValueError, "Unsupported trigger"):
            self.apply()

    def test_quiesced_is_required_and_cli_roundtrip(self):
        members = self.target.with_name("members.json")
        members.write_text(json.dumps(self.members))
        script = Path(__file__).with_name("worker-tree.py")
        common = ["--db", str(self.target), "--root", "10", "--expected-members", str(members)]
        for action in ("plan", "backup", "verify", "apply", "restore"):
            command = [sys.executable, str(script), action, *common]
            if action != "plan":
                command += ["--backup", str(self.backup)]
            if action in ("apply", "restore"):
                with self.assertRaisesRegex(ValueError, "quiesced"):
                    tree.mutate(self.target, self.backup, 10, self.members)
                command += ["--quiesced"]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(json.loads(result.stdout))


if __name__ == "__main__":
    unittest.main()
