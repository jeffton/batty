# Pi 1.5 migration

## Compatibility boundary

Upgrade the Pi packages and Chord together to 1.5.0. Batty requires Node 24.15.0 or later.

Durable 1.4 and 1.5 both use SQLite schema **2**. Opening the SQLite storage alone does not rewrite its rows. Persisted record formats still change:

- `pi.live` migrates from document version 1 to 3: compaction `reason` becomes `trigger`, and an existing run gains `turns: 0`. The migrated version is stored on its next write.
- Built-in `pi.tool` tasks are version 3; `pi.generation` tasks are version 2. An older Harness cannot execute newer task versions.
- A restart-limited extension task ends `faulted`, with `outcome.error.detail.reason = "restart_limit"`; it does not remain parked. Recover the work by creating a new task, not `retryTask()`.
- An interrupted model request counts as a failed attempt under the retry policy. Exhausted requests end visibly rather than being resent indefinitely.
- Stream progress is visible before persistence; the default crash-loss window is up to about one second. Graceful close flushes held changes.

**Do not downgrade by changing only the executable.** After 1.5 writes these records, a rollback requires the pre-upgrade database and matching 1.4 release. SQLite schema version 2 is not evidence of downgrade compatibility.

## Data and backup

Production storage is `/var/lib/batty2/.batty/runtime.sqlite`, with live `-wal` and `-shm` files. It holds Durable history, tasks, submissions, OptChat documents, and Batty's history/search indexes in one database. Runtime configuration and credentials are separate files under `/var/lib/batty2/.batty`; preserve these without printing their contents.

Read-only inventory on 2026-11-02, before migration:

| Item             |                  Count |
| ---------------- | ---------------------: |
| SQLite main file | approximately 7.72 GiB |
| Conversations    |                  3,982 |
| Entries          |                222,145 |
| Documents        |                253,371 |
| Submissions      |                 11,763 |
| Record IDs       |                727,883 |
| Tasks            |                225,934 |

The task inventory contained 11 running, one waiting, and 225,922 terminal tasks. Counts and WAL size change during service activity. All sampled `pi.live` revisions were version 1. Inspection used SQLite `mode=ro` and `query_only`, never a production Harness.

Backup procedure:

1. Record the installed release path/build and dependency lockfile. Check free space for the database backup, any test copy, and continued production writes; the database alone requires about 8.3 GB per copy.
2. Create a permission-restricted backup outside the release directory using SQLite's online backup API. Open the source with `mode=ro`; use incremental pages so normal writes can continue. The resulting standalone database includes committed WAL content. Copying only the live main file is not a valid backup.
3. Close the destination, verify its SQLite integrity and expected schema/table counts, and record its checksum and snapshot time. Preserve configuration/credentials with restricted permissions; do not print them.
4. Keep the pristine pre-upgrade backup untouched. Open a separate disposable copy for any writable 1.5 smoke test. Synthetic fixtures do not require a production-sized copy.
5. Deploy only through `scripts/deploy.sh` to `batty2.service`. Verify history, ongoing/recovered tasks, cron delivery, streaming, and service health. No other services or Minecraft data participate in this migration.

An online backup is transactionally consistent, but writes after its snapshot are outside its restore boundary. For a zero-gap rollback point, coordinate a quiescent snapshot before permitting 1.5 writes.

Restore boundary:

1. Stop the writer through the documented service workflow.
2. Preserve the complete post-upgrade database and WAL state separately; do not overwrite or delete it. This retains messages and task outcomes received after the backup.
3. Restore the verified pre-upgrade standalone database together with the matching 1.4 release. Do not attach post-upgrade WAL files to the restored database. Preserve configuration and credentials unless they were independently changed incompatibly.
4. Verify database integrity and service health before resuming. Reconcile post-snapshot user activity explicitly; restoring the snapshot alone does not retain those writes.

## Deployment backup

The verified pre-upgrade backup is `/var/backups/batty2/pi-1.5-20261102T134834Z/` (root-only). Its standalone database is 8,320,643,072 bytes, snapshot time **2026-11-02 13:48:35 UTC**. `quick_check` returned `ok`; all six recorded table counts match the pinned source snapshot. SHA-256: `8dc2f2235ec4d43bf5488da771934cf34efa761133a1d1628b57b8229bfc95fe`.

The manifest records release `a969e0b.1793619946`, counts and restore boundary. Restricted configuration copies and the matching release archive accompany the database. Writes after the snapshot remain in the live database and must be retained separately if a restore is needed.

Validation: `pnpm check`, **974 tests passed / 2 skipped**, Linux deploy regressions, build, packaged startup on both basepaths and offline verification passed. Independent Sol reviews approved the migration and UI changes.

## Regression evidence

`src/server/durable-migration.test.ts` embeds compressed DDL and exact rows generated by the real SDKs in isolated temporary databases, with no production content:

- The existing 1.2/schema-1 fixture exercises the schema-2 table migration and retained document deltas.
- A real 1.4/schema-2 fixture includes pending work, a sleeping checkpoint/deadline, a task left running by a process exiting with status 73, and version-1 `pi.live` compaction state. A storage-only 1.5 open preserves every row. Harness reopen resumes interrupted/pending work, upgrades and persists `pi.live` version 3, preserves document history, and delivers sleeping work once after its deadline across repeated restarts.
- Two additional real 1.4 process-crash fixtures stop inside a faux model request and a replay-safe tool. Genuine `pi.generation` v1 / `pi.tool` v2 tasks migrate and finish under 1.5, and `pi.live.run` gains `turns: 0`. The interrupted model request consumes a retry attempt; with no retry budget it settles `unanswered/interrupted` without resending. The replay-safe tool resumes once, emits one result, and the run answers. Both retain a single durable input/submission, deduplicate its request ID, and remain settled after reopen.
- A separate process-crash test verifies restart-limit terminalization, the tagged `onReport(report)` callback, and recovery by creating a new task.

These tests do not contact models or mutate production. They exercise storage/task compatibility, not the success of a live deployment.

Upstream: [Pi 1.5 release](https://github.com/earendil-works/pi/releases/tag/v1.5.0), [Durable changelog](https://github.com/earendil-works/pi/blob/v1.5.0/packages/durable/CHANGELOG.md).
