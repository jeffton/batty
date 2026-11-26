# Maintenance mode

Batty's maintenance sidecar serves the same HTTPS origin while the main process and SQLite are offline. It does not start the Batty runtime, admit cron work, expose sites, connect peers, or open the main database. The maintenance page takes precedence over working hours.

## Install on Linux

From a deployed Batty release with maintenance support, install `deploy/batty2-maintenance.service` under `/etc/systemd/system/`. Match its user, deployment root, main port if different (`BATTY_MAIN_PORT`), and provider auth path to the main unit. Give the sidecar the same provider credentials or provider-specific environment as the main model; do not load main's general-purpose environment file. Both processes use the SDK's credential store (including OAuth refreshes) and model catalog; the sidecar doesn't copy login material into maintenance status.

Create the marker directory with `sudo install -d -o roy -g roy -m 755 /var/lib/batty2/maintenance`. The nginx worker needs to traverse that path to stat `active.json`. The status file itself is owner-readable only.

Include `deploy/nginx-maintenance.conf` inside Batty's HTTPS server block. Add this to the start of its existing `location /`:

```nginx
if (-f /var/lib/batty2/maintenance/active.json) { return 418; }
```

Keep the primary Batty port private/loopback. The snippet expects Batty at the web origin's root and reserves `/maintenance/` and `/api/maintenance/`. It does not intercept a different installation's routes. Run `nginx -t` before reload. Enable and start `batty2-maintenance.service`. Verify `/api/maintenance/status` returns `{"active":false}` through the HTTPS origin and that regular Batty still works. Refresh the sidecar after future releases when maintenance is inactive.

## Run a migration

Use the local CLI as the Batty service user. Do not put secrets or raw logs in status messages: the owner can see them and may ask the model about them.

```sh
batty2 maintenance enter --url https://batty.example.org --message 'Preparing the database migration'
sudo systemctl stop batty2.service
systemctl show -p ActiveState -p SubState -p Result batty2.service
# Confirm clean shutdown before the migration writes anything.
batty2 maintenance update --message 'Copying the database' --progress 30
# Run and validate the migration with a separate, restart-independent operator/job.
batty2 maintenance allow-start --message 'Starting Batty' --progress indeterminate
sudo systemctl start batty2.service
batty2 maintenance exit
```

`enter` requires the running main service and snapshots the actual main model and thinking level, not a configured default. It switches new public requests to the sidecar, then checks the public bootstrap path is actually gated. If the proxy is misconfigured, it clears the marker and exits before any service stop. It does not interrupt established streams or stop existing jobs; only the separate clean service stop checkpoints main runs and disconnects peers. Detached commands can outlive a service stop, so coordinate writers before touching migration inputs. If you are operating from an agent running inside Batty, hand off the stop, migration, and restart to an independent local shell or systemd job first.

The main startup guard refuses to open the database in the offline phase. `allow-start` enables startup but keeps the proxy gated. Main durable jobs may resume on startup. `exit` checks the main listener's health before clearing the marker. It does not perform migration validation or service rollback. `hold` blocks future main starts again without touching a running process; stop the main unit before resuming file maintenance. On a crash or reboot the marker remains; `batty2 maintenance status` shows the saved phase and update time. Inspect the operator job before continuing. Percentages are operator-reported; omit them or use `indeterminate` when no percentage is known.

## Owner access

The guest page reveals no operation details. An existing owner cookie works without another sign-in; otherwise the standard passkey can authenticate at the same origin. Registration is only available in normal Batty. Maintenance chat reads the operator status, main unit state/exit code, HTTP readiness/build and disk space. It cannot read arbitrary files, logs, OptChat, stored conversations or environment variables, execute commands supplied by the model, or modify the service.

The current tab holds the chat in RAM and sends its plain-text transcript to the same provider as main. No transcript is uploaded as an artifact, written to disk, or sent to main. Closing or refreshing the tab ends it. On exit, the maintenance page returns to normal Batty.
