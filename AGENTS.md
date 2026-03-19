# AGENTS.md

## Deploying Batty from inside Batty

When you are running inside the Batty session and need to deploy or reload Batty itself, use the project scripts exactly as they are intended:

- Full deploy: `./scripts/deploy.sh`
- Fast self-reload after a local build: `./scripts/reload-self.sh`

Do not replace these with direct inline restarts like:

- `systemctl restart batty.service`
- `systemctl restart batty.service && curl ...`
- any equivalent one-liner that restarts the service in the same foreground tool call

## Why

Batty is often used to deploy Batty.

A direct restart kills the currently running server process and can interrupt the active agent turn before it finishes writing its final summary. That used to leave the browser stuck in a reconnecting state and could also lose the assistant's post-deploy summary.

The current deployment flow avoids that by:

1. building and validating first
2. handing restart off to `scripts/handoff-restart.sh`
3. scheduling the actual restart in a transient `systemd-run` unit
4. waiting before restart so the current assistant turn can finish and persist its summary
5. letting the browser reconnect to the restored session after restart
6. letting the client auto-refresh itself when the deployed build id changes

## Important operational rules

- Keep the delayed restart in `scripts/handoff-restart.sh`; it is intentional.
- Do not shorten or remove that delay unless you are explicitly reworking the self-deploy flow.
- Do not add post-restart verification commands in the same self-deploy turn if they depend on the old foreground session surviving the restart.
- If you need verification, put it in `scripts/restart-services.sh` or run it in a separate turn after the restart has happened.
- The reconnect flow depends on the client keeping `workspaceId` and `sessionPath` in the SSE URL so the server can reopen the session after process restart.
- The client update flow depends on `/api/version` and the bootstrap `buildId`; do not remove those without replacing the self-refresh mechanism.

## Expected self-deploy sequence

1. Run `./scripts/deploy.sh`.
2. Wait for the script to report that reload was handed off.
3. Finish the assistant response immediately so the summary is persisted before restart.
4. Allow the delayed restart to happen.
5. Expect the browser to refresh onto the new client build and reconnect to the same session.

If this flow breaks, inspect these files first:

- `scripts/deploy.sh`
- `scripts/reload-self.sh`
- `scripts/handoff-restart.sh`
- `scripts/restart-services.sh`
- `src/client/stores/app.ts`
- `src/client/lib/session-stream.ts`
- `src/server/main.ts`
- `src/server/pi-service.ts`
