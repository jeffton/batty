# Moving sites and importing schedules

## Hosted sites

Sites live in `<data-root>/.batty/sites/<site-id>/`. To move an existing site, back up the destination and copy its directory with the same ID, manifest, contents and visibility. Preserve `/sites/<site-id>/` paths and verify service-user access, public pages/assets and private-site login requirements.

Keeping public URLs requires the original hostname to route to the destination service. Copying files alone does not change hostname routing.

## Cron schedules

Use `batty2 cron import --json job.json` with a full Batty2 job. Import preserves ID, timestamps and `nextAt`, and rejects collisions. Ordinary `add` does not accept an existing job ID. See [the CLI reference](operations.md#cron-cli).
