# Codemode result lifecycle

New calls use SDK 1.4 `api.executeTool()`. Caller-only safe/unsafe adapters preserve each target's replay policy and Batty's output, MCP structured value, details, control and image handling. Native nested results live in caller-scoped documents until settlement; terminal task records retain small receipts. Sandbox-local cancellation aborts native children and joins active host callbacks and their cancellation cleanup before returning. Abort checks prevent dispatch after asynchronous tool resolution or receipt lookup. Cancellation is cooperative: a host tool must honor its context signal; Codemode cannot preempt arbitrary host JavaScript. Browser actions enforce their own recovery boundary. Service shutdown preserves replayable work. Workers retain caller-only tools without exposing them to the model.

Existing callers consume their recorded legacy journal before admitting native calls, preventing repeated side effects. The legacy task definition remains registered for in-flight work. Startup adds only the internal adapter names to persisted explicit allowlists containing codemode, so resumed workers can use native calls without changing their public tools.

## Legacy codemode receipts

`scripts/codemode-receipts.py` retires redundant results in legacy `batty.codemode-tool` version 2 task records. It replaces only `state.outcome.result` with `{"released":true}`; all other record fields and task columns are preserved. Conversation entries, OptChat, uploads and artifacts are untouched. The database file does not shrink; freed pages are reusable. The script never runs `VACUUM` or a checkpoint.

Deploy the legacy reader's explicit released-result error before applying. Old result replay must fail rather than interpret the marker as a successful tool result.

## Eligibility

Only terminal, completed tasks with the original `{result, structured}` payload qualify. Every task-owner ancestor must exist, be terminal and belong to the same conversation. Cycles and nonterminal descendants block cleanup. Any nonterminal task protects its entire conversation, including unrelated completed runs. Protection propagates through task owners and the conversation's `owner_task_id` and `owner_conversation_id` links, including across conversations. Active and parked child workers therefore protect their owning tasks and conversations. The SDK's immutable `TaskRecord.owner` identifies the owning task; its absence identifies a conversation-owned root, ending the chain. `completing` is not terminal.

The indexed SQLite `tasks.kind` stores a JSON-encoded string (`'"batty.codemode-tool"'`), not the bare tool name. The script selects candidates through this indexed column and reads each candidate's complete record once per inventory pass. Nonterminal ownership chains and candidate ancestors require additional metadata projections; no entries or document payloads are scanned.

## Commands

Use a concrete database path and a new backup filename on a filesystem with room for the original candidate records (previous inventory estimated about 6.6 GB).

```sh
python3 scripts/codemode-receipts.py plan --db /absolute/path/runtime.sqlite
python3 scripts/codemode-receipts.py backup --db /absolute/path/runtime.sqlite --backup /absolute/path/receipts-before.sqlite
python3 scripts/codemode-receipts.py apply --db /absolute/path/runtime.sqlite --backup /absolute/path/receipts-before.sqlite
python3 scripts/codemode-receipts.py restore --db /absolute/path/runtime.sqlite --backup /absolute/path/receipts-before.sqlite
```

`plan` and `backup` read a consistent SQLite snapshot. A long snapshot can retain concurrent WAL writes: leave disk headroom. The before-image database contains complete original task rows, primary keys, replacement records, SHA256 hashes of both complete row versions, and a manifest with row counts and logical record bytes. It is created exclusively with mode `0600`; an existing path is never overwritten. Backup creation verifies `integrity_check`, every row hash, replacement derivation and manifest counts. Interrupted or corrupt backups fail verification.

`apply` verifies the entire backup before writing and requires the same resolved target path recorded in its manifest. Each chunk uses `BEGIN IMMEDIATE`, rechecks the complete original row and current owner/descendant eligibility, then changes only the record column. Changed or ineligible rows are skipped. The default chunk is one row to bound WAL growth; `--chunk-size N` groups more rows per transaction. A partial run can be rerun safely.

`restore` also verifies the backup and restores only rows whose complete current row exactly matches the saved replacement. Concurrent or subsequent changes are skipped, never overwritten. Keep the before-image file until the result has been verified; it contains sensitive raw tool data.

This is a targeted before-image backup, not a full runtime backup. Hashes detect corruption, not malicious replacement of the backup. Output reports candidate logical bytes or updated/skipped counts plus `logical_bytes_removed`: the original record's UTF8 byte count minus its replacement's byte count, summed only for updated rows. Restore reports the inverse (negative bytes). These are not a promise of filesystem space reclaimed.

## Fixture tests

```sh
python3 scripts/test_codemode_receipts.py
```

Tests use temporary SQLite fixtures, never production data.
