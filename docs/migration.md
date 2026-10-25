# Moving sites and importing schedules

## Hosted sites

Sites live in `<data-root>/.batty/sites/<site-id>/`. To move an existing site, back up the destination and copy its directory with the same ID, manifest, contents and visibility. Preserve `/sites/<site-id>/` paths and verify service-user access, public pages/assets and private-site login requirements.

Keeping public URLs requires the original hostname to route to the destination service. Copying files alone does not change hostname routing.

## Cron schedules

Use `batty2 cron import --json job.json` with a full Batty2 job. Import preserves ID, timestamps and `nextAt`, and rejects collisions. Multiple-trigger exports also include each trigger’s `nextAt`; consumed one-shots omit it. Preserve those fields when importing so intervals retain their cadence and consumed one-shots do not repeat. The job’s `nextAt` must equal the earliest remaining trigger deadline. Single-trigger jobs need no conversion. Ordinary `add` does not accept an existing job ID. See [the CLI reference](operations.md#cron-cli).
