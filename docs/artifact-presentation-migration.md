# Artifact presentation migration

The release requires a one-time offline migration for a nonempty Batty database. Startup checks the marker; it does not convert history. Empty databases get a marker when initialized.

The migration attaches the previous history projection to the same assistant messages and direct runtime notices. It retains original tool results, inputs, existing artifact descriptors and entry IDs. Files, upload batches, site content, site visibility and file URLs are not moved. Browser descriptors retain their original handles; this does not restore expired sessions. Diffs retain their stored patches; older direct delivery may reconstruct the same patch from its original durable record. Unselected inventories do not become attachments. Historical presentation is marked to prevent new remote exports during replay. Native outputs on existing textless replies are kept there. A trailing native tool output without any owning reply used to appear as a synthetic client card. The migration does not invent a reply: the tool record and its descriptors remain in history, and the file or site remains in the library if still stored.

## Rehearse and verify

With Batty stopped, take a SQLite-consistent backup onto a different or sufficiently large volume. Do not copy only the live main database while its WAL is active. Preserve the old release and avoid running artifact-file deletion or visibility changes during the maintenance window.

```sh
umask 077
sqlite3 -readonly "$STATE/runtime.sqlite" ".backup '$BACKUP/runtime.sqlite'"
sqlite3 -readonly "$BACKUP/runtime.sqlite" 'PRAGMA quick_check;'
```

Keep that backup unchanged. Restore it into a separate private rehearsal directory on a volume that can hold both the copy and migration WAL. On that copy:

```sh
node --import tsx scripts/migrate-artifact-presentation.ts inspect "$REHEARSAL"
node --import tsx scripts/migrate-artifact-presentation.ts migrate "$REHEARSAL"
node --import tsx scripts/migrate-artifact-presentation.ts validate "$REHEARSAL"
```

`inspect` reports aggregate counts without writing entries. `migrate` puts converted metadata and its marker in one transaction, verifies each updated entry via the normal SQLite decoder, and is idempotent. Counts are attachment occurrences, not unique artifacts. `uploadedInputs` counts durable user upload descriptors (only inventoried, not migrated); `remoteFiles` counts migrated file occurrences previously imported into a `remote-*` workspace, and `remoteNotices` counts encoded notices with a remote session ID. `unrecoveredNotices` counts older notices with no exact recoverable delivery and no stored descriptors. `terminalNativeGroups` counts conversations with such trailing native outputs. Neither case assigns attachments to a different reply.

## Release and rollback

Repeat migration and validation on the stopped production database only after approving the rehearsal and verifying sufficient space for the backup and SQLite WAL. The CLI refuses to run while Batty holds the state-directory lock. Start the new release only after validation. Spot-check representative older replies across pages and verify that file links, sites, and diffs resolve as before.

If validation or a pre-release smoke check fails, keep the service stopped, preserve the failed database and any WAL/SHM as a set outside the state directory, and restore the verified pre-migration backup to `runtime.sqlite` with the original ownership and permissions. Start the old release. Restoring an older database after reopening writes would lose newer history; stop for a separate recovery decision if that happened.
