# Setup, development and operation

## Local setup

Requires Node.js **24.15.0+**, pnpm **12.15.0** and installed Google Chrome Stable for browser tools. Install JavaScript dependencies with `pnpm install`; install Chrome with `scripts/setup-chrome.sh` (Linux/macOS) or `scripts/setup-chrome.ps1` (Windows). Linux root installations also require the [browser isolation setup](#chromium-isolation).

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

Main chat submissions use the default model and thinking level selected in Settings, replacing any previous session selection. Steered and queued messages use the same defaults. Explicit subagent and cron model settings are independent.

`baseUrl` is a path prefix, not a hostname or public origin; `/` serves Batty at the root. The hostname and HTTPS origin come from hosting/proxy configuration and request headers.

`BATTY_HOST` and `BATTY_PORT` control the listener; `BATTY_SELF_PATH` selects the application files. `BATTY_PROVIDER_AUTH_PATH` selects the SDK's locked provider credential store. Application secrets and passkeys remain in the data root. Environment settings are stored in `.batty/environment.json`.

## Provider subscriptions

Settings offers **ChatGPT subscription** (`openai`), **OpenAI Codex (legacy)** (`openai-codex`) and **Anthropic (Claude Pro/Max)** (`anthropic`). Credentials stay provider-scoped in the SDK store. ChatGPT and Codex use the SDK browser flow with a pasted callback URL when signing in from another machine. Anthropic uses the SDK’s copy-code flow.

The ChatGPT flow can require organization approval (`3p_delegated_access_policy_denied`); Codex uses a separate authorization flow and remains subject to workspace Codex permissions. See [OpenAI authentication](https://developers.openai.com/codex/auth) and [Pi’s report](https://github.com/earendil-works/pi/issues/11033).

Pi 1.4 supports Anthropic subscription OAuth technically, but [Anthropic’s authentication policy](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use) does not permit third-party apps to offer Claude.ai login or route Pro/Max subscription requests. SDK support is not permission for that use.

Flows and IDs follow the installed [Pi SDK documentation](https://github.com/earendil-works/pi/blob/v1.4.0/packages/ai/README.md#oauth-providers) and [1.4.0 release notes](https://github.com/earendil-works/pi/releases/tag/v1.4.0). The generic provider-auth API uses `POST /api/provider-auth/start` with `{ providerId }`, `POST /api/provider-auth/complete` and `GET /api/provider-auth/attempt/:attemptId`; the OpenAI-specific paths are removed.

## Remote instances

See [remote instances](remote-instances.md) for node-token provisioning, remote workers and offline mirrors.

## Browser open deadlines

`browser.open` applies `timeoutMs` (default 30 seconds, range 1–60 seconds) to queue admission, SSH/display/Chromium startup, CDP attachment, navigation and the returned snapshot. Expiry or worker cancellation interrupts the action, closes its browser session and reaps owned startup processes before releasing its action queue. Bounded process cleanup can add a few seconds; a timeout while waiting behind another action does not close that action’s browser. Other browser actions retain their Playwright action/navigation timeout semantics.

## Cloud-browser operation deadlines

Cloud state, WebSocket admission, controls, touch input and capture setup share a 15-second deadline, including queue admission and persistent-session reconnection. A running operation that exceeds it closes only that unresponsive browser session and releases its queue; bounded process cleanup can add a few seconds. A queued request that expires does not close the browser being used by its predecessor. Timeouts return HTTP 504 or an explicit socket error, without automatic reconnect retries. Reopening an ended browser requires an explicit new session; no login or empty browser is silently substituted.

## Chromium isolation

Linux installations running Batty as root launch tool Chromium and its private Xvfb as the dedicated `batty-browser` account, with supplementary groups cleared and a minimal environment. Chromium's namespace and seccomp sandbox remain enabled; there is no `--no-sandbox` mode or root-browser fallback. Ordinary macOS/Windows and non-root Linux browsing use their current user with Chromium's sandbox enabled.

### Installed Chrome and updates

Production browser tools and shared headless work use **installed Google Chrome Stable**, controlled by Patchright. Discovery uses `/opt/google/chrome/chrome` on Linux, system/user Applications on macOS, and Program Files/LocalAppData on Windows. Missing Chrome fails explicitly; bundled Chromium is reserved for test fixtures. `BATTY_BROWSER_EXECUTABLE_PATH` overrides discovery with an existing absolute executable; root-isolated Linux tools require the package-managed `/opt/google/chrome/chrome`.

Deployment installs missing Chrome with `bash scripts/setup-chrome.sh` (Linux/macOS) or `scripts/setup-chrome.ps1` (Windows). The Linux helper supports Debian/Ubuntu x86_64 and installs Google's official DEB/repository; other Linux distributions require installation with their package manager. Google does not provide Linux ARM Chrome. The macOS helper uses Homebrew for missing Chrome; an existing manually installed Chrome is accepted. Windows uses winget when installation is needed. Normal Chrome installations retain their Google Updater on macOS/Windows.

Linux updates arrive through APT, including security fixes, independently of npm/Patchright. The dependency review checks Chrome Stable release notes and installed/running versions as well as Patchright. Explicit updates: `sudo bash scripts/setup-chrome.sh --update`, `bash scripts/setup-chrome.sh --update` for Homebrew-managed macOS installations, or `./scripts/setup-chrome.ps1 -Update` on Windows. Manually installed macOS Chrome uses Google Updater. Chrome for Testing does not auto-update and is not the production default.

Linux deployment runs `sudo bash scripts/setup-browser-isolation.sh`: it creates the locked browser account/private profile directories and loads the executable-scoped AppArmor allowance. It uses Ubuntu's existing Chrome profile where present, avoiding duplicate attachments. The Chrome installation stays package-managed; it is not copied into a frozen browser cache. To prepare pinned test Chromium separately, run `pnpm exec patchright install chromium` and `sudo bash scripts/setup-browser-isolation.sh --test`.

Chrome updates require browser-process restart, not just a Batty service restart: detached browsers survive the latter. On the maintained Linux installation, run this detached maintenance after a Chrome package change:

```sh
systemd-run --unit=batty-browser-refresh --collect --property=Type=exec \
  /bin/bash /root/github/batty/scripts/restart-browsers.sh /var/lib/batty2
```

The script stops only `batty2.service`, closes all stored workspace browser processes with CDP `Browser.close` to flush cookies, then starts the service. The CLI refuses to run while the service owns its runtime lock. Profiles/login remain; live tabs/viewer handles end. Observe the unit result, service health and the sandbox smoke afterward. On macOS/Windows, stop that installation's Batty service, run `node dist/server/close-browsers.mjs BATTY_ROOT`, and start it again.

Desktop extensions can use the same installed Chrome **binary**, but Batty keeps its own profile. CDP does not attach to the user's normal Chrome profile. macOS/Windows cloud live-view capture remains unsupported.

Installed Chrome releases independently of Patchright's pinned Chromium, so verify browser compatibility after upgrades. The isolation smoke covers CDP, evaluation, upload/download, namespace/seccomp sandboxing and H.264; verify shared headless navigation as well. Control receipts remain root-only; close/expiry preserves browser profiles and login.

After building/deploying, verify with `sudo node dist/server/verify-browser-isolation.mjs` (installed release: `/opt/batty2/current/dist/server/verify-browser-isolation.mjs`). Set `BATTY_BROWSER_SSH_DESTINATION=user@host` to include an SSH SOCKS navigation check. The isolated smoke command checks UID, cleared groups/capabilities, `chrome://sandbox` namespace/seccomp status, unprivileged Xvfb, H.264 frames and private upload/download fixtures. It never opens installation data or uses credentials. The account boundary protects service/root files, not sessions from other sessions sharing that browser UID; CDP and authenticated agent access remain trusted.

## Native cloud-browser video

Linux browser sessions require `Xvfb`, `xauth` and FFmpeg with `x11grab` and `libx264` (Ubuntu: `apt install xvfb xauth ffmpeg`). The Linux deployment preflight checks these binaries and performs a small H.264 encode before activating a release. Chromium owns a private authenticated 4096×4096 X display; display receipts and authority files stay in its private session directory. Browser and display processes survive service restarts; explicit browser close or expiry removes them. FFmpeg runs only while a viewer is attached.

Cloud video uses H.264/WebCodecs, not JPEG. Viewers require H.264 `VideoDecoder` support. Cloud viewports fit proportionally within 1365 CSS pixels per dimension and scale to the viewer; oversized tool/API requests are fitted too. Headless sessions without cloud viewing retain the larger viewport range. Native cloud-browser viewing is intentionally Linux-only for this installation; macOS/Windows deployments must not port it or add a fallback unless the user explicitly requests it. macOS/Windows tool browsing and ordinary headless browser sessions remain available and are not Linux-only. A headless process created before native capture cannot acquire an X display; viewing returns an explicit error and preserves the process, tabs and cookies. Replacing it requires an explicit browser close/open. This is a breaking transport/platform change; there is no automatic migration or compatibility fallback.

### Native browser prompts

New Chromium processes read profile preferences `credentials_enable_service=false` and `translate.enabled=false`. These disable Chrome’s password-saving offers and automatic Translate bubbles, not webpage password fields, Batty’s client-side Login/AutoFill panel, or a website’s language controls. Manual Chrome translation remains available.

Preferences are written before process launch, never into a profile owned by a running browser. Existing browsers retain their runtime preferences, tabs and login across deploy/reconnect; applying these defaults requires a new browser process. An existing native bubble must be dismissed separately; no page reload or browser restart is needed just to close it.

The preference names and behavior are documented in Chromium’s [password-manager preferences](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.12/components/password_manager/core/common/password_manager_pref_names.h) and [Translate preferences](https://chromium.googlesource.com/chromium/src/+/refs/tags/153.0.8010.12/components/translate/core/browser/translate_pref_names.h). They are not command-line feature switches.

### Remote website passkeys

Tool-controlled browsers do not support WebAuthn/passkeys, including when a cloud viewer attaches later. A context-wide script hides `PublicKeyCredential` and rejects public-key credential requests and creation with `NotAllowedError`, including conditional mediation. Password and other credential types retain their browser behavior. Websites must offer their own password or alternative login; passkey-only sites are unsupported. This does not affect passkey authentication to Batty itself.

The policy runs before website scripts in frames and on navigation. Reconnected browser documents also receive it without reloading or clearing page state. An already pending WebAuthn request/native dialog is not cancelled, and scripts that cached the original API before installation can retain it; reload explicitly or replace the browser if needed. This capability policy is not a security boundary against hostile page scripts. Device passkeys are not forwarded to the VPS.

### Local credential inputs

A detected sign-in form replaces the bottom keyboard bridge with local username/password inputs using `autocomplete="username"` and `autocomplete="current-password"`. Verify the displayed remote origin, choose a login on the device, then select **Fill**. This only fills remote fields; sign in on the remote page separately. Both local inputs remain available on username-only and password-only steps for password-manager compatibility; only the fields present in that remote step are filled, and unused values are discarded. Password-manager suggestions depend on the client. This paired-input flow has not been physically tested on iOS; Batty does not impersonate the remote origin for AutoFill.

Detection requires a password sign-in signal or an identifiable username sign-in form, not an arbitrary email/search field. Signup, reset, ambiguous, embedded and shadow-DOM forms are unsupported and retain the ordinary keyboard bridge. The authenticated, same-origin endpoint binds each one-use fill to the session, document, form identity, page revision and exact URL. Navigation and replaced targets are rejected.

Credentials bypass chat, agent tools and request/error logs. Local inputs clear after a handoff, navigation, form replacement or disconnection. Existing remote password values are not returned in viewer state. Credentials are sent to the VPS and remote page, which remain trusted recipients; this is not a vault or protection against an agent inspecting the page. No credentials are stored server-side. The website controls its own input-event behavior, login and cookies.

## Foreground push suppression

Before delivering a completion push, the server sends a one-use foreground challenge over the existing authenticated session SSE streams. A client acknowledges only while `document.visibilityState === "visible"` and `document.hasFocus()` is true; a partially visible but unfocused window does not suppress push. Any valid acknowledgement within one second suppresses that completion's push to all of the owner's devices. Hidden, suspended or disconnected clients do not suppress delivery; without an acknowledgement, push goes to all subscriptions normally. Suppressed completions are not queued for later delivery.

This uses no periodic client presence traffic. Challenges are bound to live stream IDs and a specific delivery, expire after one second and cannot be reused. Batty has one authenticated owner per installation; stream/challenge state belongs to that installation's push service, not a global cross-installation registry. The authenticated acknowledgement endpoint shares the normal API authentication boundary. Actual Web Push delivery and service-worker `showNotification()` are unchanged; there are no silent pushes.

## Checks

`pnpm test` runs the server/shared and client-component groups. Server tests reuse Node threads; files with module mocks belong in `mockedServerTests` in `vite.config.ts` and run with isolated module graphs. Component tests use isolated happy-dom environments. Durable replay, process cancellation, browser persistence and SQLite scaling regressions remain in the standard suite.

```sh
pnpm test
pnpm test:browser  # Browser fixtures, layout and native cache (Chromium/WebKit)
pnpm test:all      # All groups; required before pushing
```

Browser fixture servers use separate temporary Vite caches and a 30-second integration-test budget. Wait for observable state or events rather than fixed sleeps. Viewport cases cover layout; dark-mode cases cover styling rather than repeating every interaction.

Before pushing changes, run the complete source validation below. Installations pull validated commits; deployment installs locked dependencies, builds the release and verifies the running service without repeating development checks or browser tests.

```sh
pnpm check
pnpm test:all
bash scripts/deploy.test.sh  # Shared deployment lifecycle checks
bash scripts/deploy-macos.test.sh  # launchd activation checks, on macOS
pnpm build
node scripts/verify-startup.mjs
node scripts/verify-offline.mjs
```

The startup smoke check launches the packaged server with isolated runtime data at root and prefixed base paths. It verifies health/build ID, the rendered public base, authentication and HTTPS-origin browser controls without accessing installation data or model providers.

The pre-push offline verification script exercises the production build's offline reload, private image previews and incremental reconnect against local fixtures. It is a browser regression gate, not an installation health check. Client API details are in [src/client/API.md](../src/client/API.md).

## Deployment

The Linux deployment uses systemd. [deploy/batty2.service](../deploy/batty2.service) and [deploy/nginx.conf](../deploy/nginx.conf) are installation templates; adapt paths, hostname and certificate paths to your installation. The nginx template contains an example hostname, not the live site's canonical origin.

For the maintained installation, source is `/root/github/batty`, tracking `main` in `jeffton/batty`; state is `/var/lib/batty2/.batty`. The canonical URL is `https://batty.roybot.se`, proxied to loopback port 3148. The service is **`batty2.service`**. Batty1 history is retained in Git; archived data is not a deployment target.

```sh
./scripts/deploy.sh
```

The script checks disk space, installs locked dependencies and builds an immutable release, atomically switches `/opt/batty2/current`, restarts `batty2.service` and waits up to five minutes for health and the expected build ID, including time for durable database migrations. It retains the active release and two healthy rollbacks. Pi Durable resumes committed work; shell jobs use stable execution receipts and detached Chromium can retain tabs, cookies and live page state. A kernel lifetime lock prevents concurrent database writers. Unsafe interrupted external actions are reported as errors rather than automatically repeated.

### macOS and launchd

Install Homebrew's `flock` (`brew install flock`) alongside Node and pnpm. Run deployment as the logged-in service user, without sudo:

```sh
./scripts/deploy-macos.sh
```

The script pulls source, builds an immutable release and hands activation to a launchd-owned worker. The worker switches the release, reloads the agent and verifies `/healthz` and its build ID. Failed activation restores the previous agent and release. A kernel lock rejects overlapping activations. The active release and two healthy rollback candidates are retained, including their client assets.

Defaults are `~/Library/Application Support/Batty2/app` for releases, `~/Library/Application Support/Batty2/root` for state and `se.roybot.batty` for the launch agent. Configure `.batty/options.json` in the state root before deploying. `BATTY2_INSTALL_ROOT`, `BATTY2_ROOT` and `BATTY2_LABEL` override these defaults. An existing agent's listener and environment are preserved; a first install listens on loopback port 3147. The deployment command returns after handing off the worker, before activation completes. Logs are in `~/Library/Logs/Batty2`; the release's `ACTIVATION_RESULT` records `PENDING`, `SUCCEEDED` or `FAILED`, with details in `DEPLOY.log`. The cron CLI is installed at `~/.local/bin/batty2` with the installation's state root and listener.

`BATTY2_ALLOW_DIRTY=1` explicitly permits deploying tracked edits and nonignored new files. Deployment does not copy state or import chats.

#### Optional LAN HTTPS with Caddy

Install Caddy (`brew install caddy`) and create `https/Caddyfile` beside the installation's `app` directory (default `~/Library/Application Support/Batty2/https/Caddyfile`). Deployment validates this file and installs a second launch agent, `<BATTY2_LABEL>.https`, which restarts with each deployment and at login. Without a Caddyfile, deployment leaves HTTPS services untouched. Configuration and CA storage remain outside releases and Git.

Example Caddyfile; replace `my-mac.local` with the Mac's LAN hostname (`scutil --get LocalHostName`, plus `.local`):

```caddyfile
{
    admin off
    persist_config off
    auto_https disable_redirects
    skip_install_trust
    storage file_system ./data
}

https://my-mac.local:3443 {
    tls internal
    reverse_proxy 127.0.0.1:3147
}
```

Caddy runs with the HTTPS directory as its working directory. Keep `data` when reinstalling: it contains the CA and private keys. Only distribute `data/pki/authorities/local/root.crt` to clients that should trust this installation; never distribute private keys. Trust installation is manual, including on the Mac. Passkeys belong to the HTTPS hostname; localhost passkeys do not transfer.

Keep Batty's `BATTY_HOST` on `127.0.0.1` in its launch agent (and `.batty/environment.json`, if configured), and match the proxy's upstream to `BATTY_PORT`. Caddy listens on all interfaces by default; use its `bind` directive to restrict it to a particular LAN address if needed. The script does not open firewall ports, create tunnels or configure router forwarding. Use only on trusted networks. Batty authentication is unchanged.

Activation verifies Batty's health/build ID and that the HTTPS launch agent starts. A failure restores the previous release and launch agents; the user-owned Caddyfile is not rolled back. HTTPS logs are `https.log` and `https-error.log` alongside the Batty logs. After setup or configuration changes, verify the actual hostname and CA trust from each client:

```sh
curl --cacert "$HOME/Library/Application Support/Batty2/https/data/pki/authorities/local/root.crt" \
  https://my-mac.local:3443/healthz
```

To remove HTTPS, boot out the HTTPS launch agent, delete its plist from `~/Library/LaunchAgents`, and remove the Caddyfile. Retain the CA storage if its trust should survive a later reinstall.

### Windows and IIS

Windows requires PowerShell 7 (`pwsh.exe` on the service account’s PATH) and the same Node/pnpm versions as local setup. Agents use the `powershell` tool; interrupted commands are reported as errors rather than replayed after a restart. Detached Chromium survives service restarts, and Windows kernel file-sharing locks prevent concurrent database writers. Linux agents use durable Bash supervisors; `BATTY_BASH_PATH` selects a custom executable (default `/bin/bash`).

The Windows script updates an installed WinSW service without changing its XML, account, environment or data root. IIS requires URL Rewrite, ARR proxying and the `HTTP_X_FORWARDED_HOST`/`HTTP_X_FORWARDED_PROTO` server variables. Point the IIS application at the `current` junction. `deploy/web.config` forwards the application-relative path to the backend; set `baseUrl` to the public IIS prefix, such as `/batty`.

The maintained installation uses source `D:\github\batty`, application `D:\Batty\app`, state `D:\Batty2\root\.batty`, service `Batty`, pool `BattyProxy` and IIS application `/batty`. The service XML points its start and authenticated stop commands at `current\dist\server\main.mjs` and `stop-service.mjs`, both with `D:\Batty2\root` as their data-root argument. The Batty1 root and backups are frozen archives.

```powershell
.\scripts\deploy-windows.ps1 -StageOnly
.\scripts\deploy-windows.ps1 -ReleasePath D:\Batty\app\releases\RELEASE
```

Staging pulls validated source, installs locked dependencies and builds without interrupting the service. Production dependencies are hardlinked from pnpm's store; do not edit release `node_modules` files. Use `-AllowDirty` for explicitly approved uncommitted work. Activation runs from elevated Windows PowerShell with WebAdministration installed: it stops the service, switches the junction, recycles the IIS pool and checks the backend and IIS build IDs, app shell, script and manifest. `-IisUrl` selects the IIS application URL (default `http://localhost/batty/`). A failed health gate restores the previous release. Releases and live state are retained; updates do not copy data, import history or modify schedules.

Run activation outside the WinSW process tree. From the running assistant, use a one-shot Windows Task Scheduler task targeting the second command. A detached child process can still be terminated when the service stops.

## Durable schema and recovery

Pi Durable 1.4 migrates SQLite to schema 2 on open, rebuilding the task table atomically. Before upgrading a schema-1 installation, take a consistent SQLite online backup, verify `PRAGMA integrity_check`, and retain its checksum. Allow free disk space for both the rebuilt task table and its transaction journal/WAL. Do not copy a live database file without SQLite's backup API.

Schema 2 cannot be opened by Pi Durable 1.3 or earlier. Rolling back across this boundary requires stopping the service and restoring the verified pre-migration database, including handling its WAL/SHM files while no process has the database open. That restore also discards work committed after the backup; changing only the release symlink is insufficient.

Sleeping tasks retain their checkpoint and deadline without holding an invocation. Five consecutive crash-interrupted restarts without a new commit park a task with `restart_limit`; clean shutdowns do not count. Runtime reports log the task identity and reason. Inspect the cause before explicitly retrying a parked task through `Harness.retryTask()`; no automatic retry bypasses this guard.

## Codemode task receipts

Codemode uses Pi Durable 1.4 native version 2 tasks and `output` receipts. Version 1 task migration and legacy `content` receipt conversion are unsupported. Old unfinished codemode calls cannot resume; completed transcripts and artifacts remain stored without history migration.

## AI tool names

Batty-owned AI tools use snake_case. `web_search`, `attach_files` and `attach_artifacts` replace their hyphenated names, including codemode discovery and `tools.<name>` invocation. MCP names keep their existing `mcp__` normalization; codemode's JavaScript helpers such as `searchTools` are unchanged.

This is a breaking change without aliases or history migration. Instructions and scripts must use the new names. Persisted calls retain their original names: unfinished calls or codemode scripts using renamed tools cannot resume under this release. Completed results and artifacts remain stored, but name-specific UI rendering uses the new names.

## Image reads in codemode

`tools.read` returns a string: file text or an image's text note. Image blocks are forwarded automatically to the model, even when the script ignores the return value or fails after the read completes. Image bytes do not enter the script. `text(await tools.read(...))` prints only the note; `await tools.read(...)` alone displays the image.

This breaks scripts expecting an image object from `read`: remove `image(await tools.read(...))`. The `image(block)` helper remains available for explicitly supplied image data. Direct `read` calls are unchanged.

## Web search in codemode

`tools.web_search` returns structured data, not formatted text. Search returns `{ action, query, count, country, freshness?, includeContent, results }`, with `{ title, link, snippet, age, content? }` per result. Content extraction returns `{ action, url, content }`. Page content includes existing error/challenge text and is not truncated in scripts. Model-facing text keeps its output limit and full-text file.

This is a breaking return-type change for scripts expecting a string.

## Cron CLI

Deployment installs `/usr/local/bin/batty2`. It authenticates with the local state secret and calls the running scheduler; it does not start another scheduler.

```sh
batty2 cron add --workspace my-project --title 'Task review' --prompt 'Review outstanding tasks' --in 3m
batty2 cron list
batty2 cron list --workspace my-project
batty2 cron get JOB_ID
batty2 cron update JOB_ID --title 'Weekly task review'
batty2 cron update JOB_ID --enabled false
batty2 cron remove JOB_ID
batty2 cron import --json job.json
batty2 cron add --title 'Offer watch' --prompt 'Check relevant deals' \
  --at 2026-11-20T10:00:00+01:00 --at 2026-11-23T10:00:00+01:00 \
  --cron '0 8,12,16,20 27 11 *' --timezone Europe/Stockholm
batty2 --help
```

Jobs require a nonempty `title` on creation and import. `list` includes all workspaces by default; `--workspace ID` (AI/API: `workspaceId`) explicitly filters it. It returns only ID, title, workspace, enabled status, schedule and next/retry times; `get JOB_ID` returns the full job including prompt and execution settings. The AI cron tool uses the same `title`, `list` and `get` fields/actions. This is a breaking list-response change; full job data is fetched explicitly, with no legacy aliases or title inference.

`--root` defaults to `/var/lib/batty2`. `--json FILE` accepts request fields (`-` reads stdin); flags override them. Repeat or combine `--at`, `--in`, `--every` and `--cron` for multiple triggers on one job. `--timezone` applies to every `--cron` flag; use JSON for per-trigger timezones.

The API and AI tool accept `schedule: {kind: "multiple", triggers: [{kind: "at", at: "2026-11-20T10:00:00+01:00"}, {kind: "cron", expression: "0 10 * * 1", timezone: "Europe/Stockholm"}]}`. Nested multiple schedules and empty trigger lists are rejected. Due triggers coalesce into one run; future triggers keep their deadlines. Editing only a title or prompt preserves deadlines, while replacing `schedule` resets all of them. See [migration](migration.md) for schedule imports.

## Push notifications

Web push uses the PWA service worker. Sending a message requests permission; authenticated startup resynchronizes granted subscriptions without prompting. Main assistant replies notify even with the app closed. Direct cron deliveries can also notify; tool handoffs, ordinary subagent replies, empty completions and `NO_REPLY` do not. Notification clicks open the permanent chat. VAPID keys and subscriptions live in `.batty/web-push`; `webPushSubject` is the configured VAPID contact subject.

## Browser diagnostics

Authenticated online clients report window errors, unhandled rejections, Vue errors and caught file-read/submission failures to `/api/browser-errors`. Reports include build/time, browser/platform family, stage, native error name, allowlisted diagnostic messages, asset-only stack locations, HTTP status and a random correlation ID. Failed requests used by main-chat banner handlers also include an allowlisted operation (bootstrap, history, push sync, version check, etc.), request-start/error visibility, whether the page suspended during the request, and the latest lifecycle/connection event. URLs, cursors and request bodies are not logged. Prompt text, filenames, images, response bodies and URL queries are excluded. Unknown messages are redacted. Background version and app-shell check failures are diagnostic-only; user and data request failures remain visible in the UI.

The private log is `.batty/browser-errors.json`: up to 200 reports, seven days of retention and hourly expiry. Inspect it with `jq . /var/lib/batty2/.batty/browser-errors.json`. Submission `correlationId` values also appear in `journalctl -u batty2.service`. Client/server limits are 10/20 reports per minute with duplicate suppression; telemetry failures are discarded without retries.
