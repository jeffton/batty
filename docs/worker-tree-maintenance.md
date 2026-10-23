# Offline worker-tree removal

`scripts/worker-tree.py` makes a targeted SQLite before-image backup and atomically deletes or restores one settled worker-conversation ownership tree. It supports Pi Durable schema 2 and the installed Batty index tables; it has no application-specific root IDs.

Supply an independently checked JSON array of **all** expected conversation IDs, including the root:

```sh
python3 scripts/worker-tree.py plan --db /absolute/runtime.sqlite \
  --root ROOT --expected-members /absolute/members.json
python3 scripts/worker-tree.py backup --db /absolute/runtime.sqlite \
  --root ROOT --expected-members /absolute/members.json --backup /absolute/before.sqlite
python3 scripts/worker-tree.py verify --db /absolute/runtime.sqlite \
  --root ROOT --expected-members /absolute/members.json --backup /absolute/before.sqlite
```

`plan` checks eligibility and counts rows without hashing or copying historical payloads. Backup uses one consistent read transaction, exclusively creates a mode-0600 file, and streams complete native SQLite rows, including keys. Its manifest records the source path/inode, schema fingerprint, exact membership, retained identity tombstones, column/key definitions and per-table SHA-256/counts. `verify` checks backup integrity, manifest and row hashes without opening the source database. Offload and independently verify the backup before deletion. A failed backup file is incomplete; use a new destination after resolving the error.

Stop the runtime before either write operation and keep it stopped until the operation finishes. `--quiesced` is an operator assertion, not a process detector:

```sh
python3 scripts/worker-tree.py apply --db /absolute/runtime.sqlite \
  --root ROOT --expected-members /absolute/members.json --backup /absolute/before.sqlite --quiesced
# Explicit recovery, while stopped:
python3 scripts/worker-tree.py restore --db /absolute/runtime.sqlite \
  --root ROOT --expected-members /absolute/members.json --backup /absolute/before.sqlite --quiesced
```

Apply takes `BEGIN IMMEDIATE`, rechecks exact membership, worker parents, idle live/inbox checkpoints, settled tasks/submissions, replay dependencies, external history-head references, schema, identities and every original row hash before deleting anything. A changed row or new scoped row fails the whole transaction. Restore requires empty original scopes and absent keys/logical document addresses, then inserts exact before-images without overwriting. The history INSERT trigger is suspended and reinstated within the restore transaction to preserve exact derived counts. Neither operation silently skips conflicts or automatically reverses a committed deletion. Always restart the service after the offline operation, including on failure.

## Scope and safety boundary

Deleted: tree conversations, their entries/submissions/tasks, conversation/task-scoped document incarnations and all revisions, plus their history visibility/count and logical memory-search rows/cursors. FTS schema and unrelated logical rows remain intact; internal FTS page layout is derived, not a before-image contract.

Preserved: `record_ids` historical identities, ID/sequence allocation metadata, main/other conversations, parent-owned delivery/anchor tasks, session-scoped worker/delivery registries and references, filesystem uploads/sites/artifacts. Worker-native memory documents are in scope; main memory is not. Physical SQLite file size is not reclaimed by this operation.

The replay guard starts with every nonterminal task and queued/placed submission. It checks exact numeric/decimal-string ID values in active records (including completing outcomes/memos), follows task input/checkpoint/wait/ownership links and referenced-record ownership metadata, and refuses an inspection exceeding 100,000 graph nodes. It does **not** scan historical model/memory bodies or terminal outcome payloads. This covers the installed Batty delivery/await/command protocols, not arbitrary custom tasks that encode references inside opaque strings or interpret terminal result text as executable IDs. Conservative exact-ID matches may refuse an otherwise safe tree.

SQLite locking does not invalidate runtime caches or prevent later resume/steer requests. Keep the runtime stopped during mutation and deploy missing-conversation lifecycle handling before removal. Historical registry references intentionally survive; they are not permission to recreate deleted conversations.

Fixture-only checks: `python3 -m unittest discover -s scripts -p 'test_worker_tree.py'`.
