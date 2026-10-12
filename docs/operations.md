# Setup, development and operation

## Local setup

Requires Node.js **24.15.0+** and pnpm **12.11.0**. Install dependencies with `pnpm install`.

The server takes a data-root argument and stores state in its `.batty` directory. The package scripts use `/var/lib/batty2`; to use another root, run `pnpm exec tsx watch src/server/main.ts /absolute/data/root`.

Create `<data-root>/.batty/options.json` with the required workspace roots and VAPID contact subject:

```json
{
  "workspacesRoots": ["/absolute/path/to/projects"],
  "webPushSubject": "mailto:you@example.com",
  "baseUrl": "/"
}
```

Workspace directories are direct children of the configured roots. Choose the assistant workspace in Settings. Global instructions and skills live in `<data-root>/.batty/AGENTS.md` and `<data-root>/.batty/skills/`; workspaces can supply their own instructions and skills.

```sh
pnpm dev
pnpm dev:client
```

Run the two development servers in separate terminals and open `http://localhost:5173`. The backend defaults to `127.0.0.1:3148`. First startup prints a setup code for passkey registration. Use HTTPS for a hosted installation, then connect model providers and select the default model in Settings. Configure a Brave Search key there to enable web search.

`baseUrl` is a path prefix, not a hostname or public origin; `/` serves Batty at the root. The hostname and HTTPS origin come from hosting/proxy configuration and request headers.

`BATTY_HOST` and `BATTY_PORT` control the listener; `BATTY_SELF_PATH` selects the application files. `BATTY_PROVIDER_AUTH_PATH` selects the SDK's locked provider credential store. Application secrets and passkeys remain in the data root. Environment settings are stored in `.batty/environment.json`.

## Checks

```sh
pnpm check
pnpm test
pnpm build
node scripts/verify-offline.mjs
```

The offline verification script exercises the production build's offline reload, private image previews and incremental reconnect. Client API details are in [src/client/API.md](../src/client/API.md).

## Deployment

The Linux deployment uses systemd. [deploy/batty2.service](../deploy/batty2.service) and [deploy/nginx.conf](../deploy/nginx.conf) are installation templates; adapt paths, hostname and certificate paths to your installation. The nginx template contains an example hostname, not the live site's canonical origin.

For the maintained installation, source is `/root/github/batty2`, tracking `main` in `jeffton/batty`; state is `/var/lib/batty2/.batty`. The canonical URL is `https://batty.roybot.se`, proxied to loopback port 3148. The service is **`batty2.service`**. The Batty1 code and data are an archive, not a deployment target.

```sh
./scripts/deploy.sh
```

The script checks disk space, builds and tests an immutable release, runs the offline gate, atomically switches `/opt/batty2/current`, restarts `batty2.service` and verifies the build ID. It retains the active release and two healthy rollbacks. Pi Durable resumes committed work; shell jobs use stable execution receipts and detached Chromium can retain tabs, cookies and live page state. A kernel lifetime lock prevents concurrent database writers. Unsafe interrupted external actions are reported as errors rather than automatically repeated.

### Windows and IIS

Windows requires Git for Windows (Bash), PowerShell and the same Node/pnpm versions as local setup. `BATTY_BASH_PATH` selects a custom Bash executable; the default is `C:\\Program Files\\Git\\bin\\bash.exe`. Durable shell supervisors and Chromium survive service restarts, and Windows kernel file-sharing locks prevent concurrent database writers.

The Windows script updates an installed WinSW service without changing its XML, account, environment or data root. IIS requires URL Rewrite, ARR proxying and the `HTTP_X_FORWARDED_HOST`/`HTTP_X_FORWARDED_PROTO` server variables. Point the IIS application at the `current` junction. `deploy/web.config` forwards the application-relative path to the backend; set `baseUrl` to the public IIS prefix, such as `/batty`.

The maintained installation uses source `D:\github\batty`, application `D:\Batty\app`, state `D:\Batty2\root\.batty`, service `Batty`, pool `BattyProxy` and IIS application `/batty`. The service XML points its start and authenticated stop commands at `current\dist\server\main.mjs` and `stop-service.mjs`, both with `D:\Batty2\root` as their data-root argument. The Batty1 root and backups are frozen archives.

```powershell
.\scripts\deploy-windows.ps1 -StageOnly
.\scripts\deploy-windows.ps1 -ReleasePath D:\Batty\app\releases\RELEASE
```

Staging pulls source, installs locked dependencies, checks, tests, builds and runs the offline gate without interrupting the service. Use `-AllowDirty` for explicitly approved uncommitted work. Activation runs from elevated Windows PowerShell with WebAdministration installed: it stops the service, switches the junction, recycles the IIS pool and checks the backend and IIS build IDs, app shell, script and manifest. `-IisUrl` selects the IIS application URL (default `http://localhost/batty/`). A failed health gate restores the previous release. Releases and live state are retained; updates do not copy data, import history or modify schedules.

Run activation outside the WinSW process tree. From the running assistant, use a one-shot Windows Task Scheduler task targeting the second command. A detached child process can still be terminated when the service stops.

## Cron CLI

Deployment installs `/usr/local/bin/batty2`. It authenticates with the local state secret and calls the running scheduler; it does not start another scheduler.

```sh
batty2 cron add --workspace my-project --prompt 'Review outstanding tasks' --in 3m \
  --session main-detached
batty2 cron list --workspace my-project
batty2 cron update JOB_ID --enabled false
batty2 cron remove JOB_ID
batty2 cron import --json job.json
batty2 --help
```

`--root` defaults to `/var/lib/batty2`. `--json FILE` accepts request fields (`-` reads stdin); flags override them. See [migration](migration.md) for schedule imports.

## Push notifications

Web push uses the PWA service worker. Sending a message requests permission; authenticated startup resynchronizes granted subscriptions without prompting. Main assistant replies notify even with the app closed. Direct cron deliveries can also notify; tool handoffs, ordinary subagent replies, empty completions and `NO_REPLY` do not. Notification clicks open the permanent chat. VAPID keys and subscriptions live in `.batty/web-push`; `webPushSubject` is the configured VAPID contact subject.

## Browser diagnostics

Authenticated online clients report window errors, unhandled rejections, Vue errors and caught file-read/submission failures to `/api/browser-errors`. Reports include build/time, browser/platform family, stage, native error name, allowlisted diagnostic messages, asset-only stack locations, HTTP status and a random correlation ID. Prompt text, filenames, images, response bodies and URL queries are excluded. Unknown messages are redacted; original UI errors remain visible.

The private log is `.batty/browser-errors.json`: up to 200 reports, seven days of retention and hourly expiry. Inspect it with `jq . /var/lib/batty2/.batty/browser-errors.json`. Submission `correlationId` values also appear in `journalctl -u batty2.service`. Client/server limits are 10/20 reports per minute with duplicate suppression; telemetry failures are discarded without retries.
