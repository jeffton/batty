# Importing history and migrating sites or schedules

## History import

The Roy importer reads Batty1 sessions carrying the daily-session marker. Stop `batty2.service` before importing:

```sh
pnpm import --dry-run
pnpm import
```

Every source record retains provenance; repeated imports are deduplicated. Adding source records is supported only before live main-thread work begins. Referenced attachments and sites retain their route identities. Other workspaces, ordinary sessions, workers and cron schedules are not imported.

Imported user messages and final assistant replies enter OptChat memory. Original tool calls, tool results and metadata remain in permanent history. Memory preparation runs independently after import; `/api/memory/status` reports progress. See [runtime memory](runtime.md#memory) for summarizer settings and offline preparation.

## Hosted sites

Sites live in `<data-root>/.batty/sites/<site-id>/`. To migrate an existing site, back up the destination and copy its directory with the same ID, manifest, contents and visibility. Preserve `/sites/<site-id>/` paths rather than creating a new site. Compare files before overwriting an existing destination and verify service-user access, public pages/assets and private-site login requirements.

Keeping old public URLs requires the original hostname to route to the destination service as well. Copying files alone does not change hostname routing. Route the old hostname after checking the copied sites; keep source data until verification is complete.

## Cron schedules

Use `batty2 cron import --json job.json` with a full Batty2 job. Import preserves ID, timestamps and `nextAt`, and rejects collisions. Ordinary `add` does not accept an existing job ID.

Import jobs disabled before cutover. Disable the source scheduler, reconcile final `nextAt` values, then enable destination jobs. History import does not copy schedules. See [the CLI reference](operations.md#cron-cli).
