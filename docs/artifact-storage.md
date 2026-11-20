# File artifact storage

Batty stores repeated file snapshots and patches once in `batty_artifact_text_v1` in `runtime.sqlite`. The SQLite write transaction stores the content and internal reference together. Reads restore the original strings before Pi replays entries and document revisions or Batty computes public `diff:` references. File paths, ownership, and attachment authorization are unchanged. Remote transfers use hydrated data, not local storage references.

The online SQLite backup API includes the content store. Worker-tree before-images are bound to the original database inode and keep using its immutable content store. Packed worker-tree before-images cannot be restored into an inline-only database. The legacy receipt retirement script refuses packed task rows. There is no retention policy or garbage collection for this content.

## Backfill and rollback

Use the Batty checkout corresponding to the deployed binary:

```sh
pnpm exec tsx scripts/artifact-dedup.ts plan /private/verified-snapshot/runtime.sqlite
pnpm exec tsx scripts/artifact-dedup.ts apply /path/to/runtime.sqlite
```

Take and verify a consistent backup first. `plan` opens its input read-only and reports candidate rows and byte estimates before SQLite overhead. `apply` requires the artifact-aware runtime with writes enabled. It updates rows in place, verifies each row round trips, and can be repeated after interruption. It leaves freed pages for SQLite to reuse; it does not run `VACUUM`.

For a binary rollback, while the artifact-aware runtime is still deployed, run `pnpm exec tsx scripts/artifact-dedup.ts inline /path/to/runtime.sqlite`. This disables packed writes in SQLite, re-inlines artifacts including writes since deployment, and verifies that no packed rows remain. Restart with the older binary only after a successful inverse. Never restore the old backup over a database with newer history. Keep the immutable store for existing worker-tree before-images. After deploying the artifact-aware binary again, `pnpm exec tsx scripts/artifact-dedup.ts enable /path/to/runtime.sqlite` enables packing.
