#!/usr/bin/env python3
"""Fixture-only tests; never opens a production database."""

import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("receipts", Path(__file__).with_name("codemode-receipts.py"))
receipts = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(receipts)


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.target = Path(self.directory.name) / "runtime.sqlite"
        self.backup = Path(self.directory.name) / "before.sqlite"
        self.db = sqlite3.connect(self.target)
        self.addCleanup(self.db.close)
        self.db.executescript("""
            CREATE TABLE tasks (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL,
                kind TEXT NOT NULL, status TEXT NOT NULL, abort_requested INTEGER NOT NULL,
                background INTEGER NOT NULL, record TEXT NOT NULL);
            CREATE INDEX tasks_by_kind ON tasks(kind, id);
            CREATE INDEX tasks_by_status ON tasks(status, id);
            CREATE TABLE conversations (id INTEGER PRIMARY KEY,
                owner_conversation_id INTEGER, owner_task_id INTEGER, record TEXT NOT NULL);
            CREATE TABLE entries (id INTEGER PRIMARY KEY, record TEXT NOT NULL);
            INSERT INTO entries VALUES (1, '{"precious":"OptChat"}');
        """)

    def task(self, task_id, owner=None, status="terminal", kind=receipts.KIND,
             conversation=1, version=2, outcome="completed"):
        record = {"id": task_id, "conversationId": conversation, "kind": kind,
                  "version": version, "input": {"name": "read", "args": {"path": "image.png"}},
                  "state": {"status": status}, "background": False, "abortRequested": False}
        if owner is not None:
            record["owner"] = owner
        if status in ("terminal", "completing"):
            record["state"]["outcome"] = {"status": outcome, "result": {
                "result": {"output": [{"type": "image", "data": "large-image" * 1000}],
                           "details": {"sentFiles": ["keep-reference"]}}, "structured": None}}
        else:
            record["state"]["checkpoint"] = {"phase": "execute"}
        self.db.execute("INSERT OR IGNORE INTO conversations VALUES (?,NULL,NULL,'{}')",
                        (conversation,))
        self.db.execute("INSERT INTO tasks VALUES (?,?,?,?,?,?,?)",
                        (task_id, conversation, json.dumps(kind), status, 0, 0, json.dumps(record)))
        self.db.commit()

    def raw(self, task_id):
        return self.db.execute("SELECT record FROM tasks WHERE id=?", (task_id,)).fetchone()[0]

    def change_status(self, task_id, status):
        record = json.loads(self.raw(task_id))
        record["state"]["status"] = status
        self.db.execute("UPDATE tasks SET status=?, record=? WHERE id=?",
                        (status, json.dumps(record), task_id))
        self.db.commit()

    def test_apply_restore_and_idempotence(self):
        self.task(1, kind="pi.tool")
        self.task(2, owner=1)
        original = self.db.execute("SELECT * FROM tasks ORDER BY id").fetchall()
        stats = receipts.make_backup(self.target, self.backup)
        self.assertEqual(stats["rows"], 1)
        self.assertGreater(stats["original_record_bytes"], stats["replacement_record_bytes"])
        applied = receipts.mutate(self.target, self.backup)
        self.assertEqual((applied["updated"], applied["skipped"]), (1, 0))
        self.assertEqual(applied["logical_bytes_removed"],
                         stats["original_record_bytes"] - stats["replacement_record_bytes"])
        self.assertEqual(json.loads(self.raw(2))["state"]["outcome"]["result"], {"released": True})
        self.assertEqual(receipts.mutate(self.target, self.backup),
                         {"updated": 0, "skipped": 1, "logical_bytes_removed": 0})
        self.assertEqual(self.db.execute("SELECT * FROM entries").fetchall(), [(1, '{"precious":"OptChat"}')])
        self.assertEqual(receipts.mutate(self.target, self.backup, restore=True)["updated"], 1)
        self.assertEqual(self.db.execute("SELECT * FROM tasks ORDER BY id").fetchall(), original)
        self.assertEqual(receipts.mutate(self.target, self.backup, restore=True)["updated"], 0)

    def test_owner_and_descendant_guards(self):
        self.task(1, kind="pi.tool", status="running")
        self.task(2, owner=1)
        self.task(3, kind="pi.tool", status="completing")
        self.task(4, owner=3)
        self.task(5, owner=999)
        self.task(6)  # conversation-owned root, but an active descendant protects it
        self.task(7, owner=6, kind="pi.tool", status="sleeping")
        self.task(8, conversation=2, kind="pi.tool")
        self.task(9, owner=8)
        self.task(10, conversation=3)  # valid conversation-owned root
        self.task(11, version=1)
        self.task(12, outcome="aborted")
        self.task(13, status="completing")
        self.assertEqual(receipts.make_backup(self.target, self.backup)["rows"], 1)
        with sqlite3.connect(self.backup) as backup:
            self.assertEqual(backup.execute("SELECT id FROM before_images").fetchall(), [(10,)])

    def test_after_backup_active_owner_and_descendant(self):
        self.task(1, kind="pi.tool")
        self.task(2, owner=1)
        self.task(3, conversation=3)
        receipts.make_backup(self.target, self.backup)
        self.change_status(1, "running")
        self.task(4, owner=3, status="waiting", kind="pi.tool", conversation=3)
        self.assertEqual(receipts.mutate(self.target, self.backup),
                         {"updated": 0, "skipped": 2, "logical_bytes_removed": 0})

    def test_changed_original_and_restore_cas(self):
        self.task(1)
        self.task(2)
        receipts.make_backup(self.target, self.backup)
        self.db.execute("UPDATE tasks SET background=1 WHERE id=1")
        self.db.commit()
        applied = receipts.mutate(self.target, self.backup)
        self.assertEqual((applied["updated"], applied["skipped"]), (1, 1))
        self.assertGreater(applied["logical_bytes_removed"], 0)
        record = json.loads(self.raw(2))
        record["unrelated"] = "new-value"
        self.db.execute("UPDATE tasks SET record=? WHERE id=2", (json.dumps(record),))
        self.db.commit()
        self.assertEqual(receipts.mutate(self.target, self.backup, restore=True)["updated"], 0)

    def test_tampered_backup_rejected_before_mutation(self):
        self.task(1)
        original = self.raw(1)
        receipts.make_backup(self.target, self.backup)
        with sqlite3.connect(self.backup) as backup:
            backup.execute("UPDATE before_images SET original_sha256='bad'")
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            receipts.mutate(self.target, self.backup)
        self.assertEqual(self.raw(1), original)

    def test_backup_never_overwrites_and_target_must_match(self):
        self.task(1)
        receipts.make_backup(self.target, self.backup)
        with self.assertRaises(FileExistsError):
            receipts.make_backup(self.target, self.backup)
        other = Path(self.directory.name) / "other.sqlite"
        sqlite3.connect(other).close()
        with self.assertRaisesRegex(ValueError, "target/format mismatch"):
            receipts.mutate(other, self.backup)

    def test_live_tasks_protect_conversation_and_cross_conversation_owners(self):
        self.task(1, conversation=1)
        self.task(2, conversation=2)
        self.task(3, conversation=3)
        self.task(4, conversation=4)
        self.task(5, conversation=5)  # unrelated, eligible
        receipts.make_backup(self.target, self.backup)
        # A separate run in the same conversation protects task 1.
        self.task(10, conversation=1, kind="pi.tool", status="sleeping")
        # Child conversation points directly at terminal owning task 2.
        self.task(20, conversation=20, kind="pi.tool", status="waiting")
        self.db.execute("UPDATE conversations SET owner_task_id=2 WHERE id=20")
        # Two conversation-only links protect task 3 transitively.
        self.task(30, conversation=30, kind="pi.tool", status="running")
        self.db.execute("INSERT INTO conversations VALUES (31,3,NULL,'{}')")
        self.db.execute("UPDATE conversations SET owner_conversation_id=31 WHERE id=30")
        # Ownership may carry both links; protect the other owning conversation too.
        self.db.execute("UPDATE conversations SET owner_conversation_id=4 WHERE id=20")
        self.db.commit()
        applied = receipts.mutate(self.target, self.backup)
        self.assertEqual((applied["updated"], applied["skipped"]), (1, 4))
        self.assertEqual(json.loads(self.raw(5))["state"]["outcome"]["result"],
                         receipts.MARKER)
        for task_id in (1, 2, 3, 4):
            self.assertIn("structured", json.loads(self.raw(task_id))["state"]["outcome"]["result"])

    def test_cli_commands(self):
        self.task(1)
        script = Path(__file__).with_name("codemode-receipts.py")
        for action, expected_key, expected_value in (
            ("plan", "rows", 1), ("backup", "rows", 1),
            ("apply", "updated", 1), ("restore", "updated", 1),
        ):
            command = [sys.executable, str(script), action, "--db", str(self.target)]
            if action != "plan":
                command.extend(["--backup", str(self.backup)])
            result = subprocess.run(command, check=True, capture_output=True, text=True)
            self.assertEqual(json.loads(result.stdout)[expected_key], expected_value)

    def test_owner_cycle_is_ineligible(self):
        self.task(1, owner=2)
        self.task(2, owner=1)
        self.assertEqual(receipts.make_backup(self.target, self.backup)["rows"], 0)


if __name__ == "__main__":
    unittest.main()
