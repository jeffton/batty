# Batty

Batty is a web UI for [Pi Coding Agent](https://pi.dev). It keeps Pi's workspace, session, model, skill, and `AGENTS.md` behavior, but gives you a fast browser app for chatting, resuming sessions, and managing cron jobs.

## What Batty does

- Responsive chat UI for desktop and mobile
- Live streaming over SSE for assistant output and tool activity
- Workspace picker with filtering and one-click workspace creation
- Session list per workspace, including resume and infinite scroll for older messages
- Model and thinking-level switching from the chat header
- Attachment support with drag and drop, file picker, and image rendering
- Local draft saving while you type, including offline/reconnecting states
- Queue follow-up prompts while a run is streaming, or send steer prompts mid-run
- Rich tool rendering, including inline diffs for edits and readable bash output
- Built-in cron jobs for scheduled agent turns
- Built-in `subagent` tool for synchronous workspace-scoped delegation
- Built-in `web-search` tool powered by Brave Search
- Passkey auth with one-time setup codes for enrolling devices
- Web Push notifications when background runs finish
- PWA install support with offline-friendly cached session snapshots
- Auto-reconnect after server restarts and auto-refresh when a new client build is deployed

## How it works

Batty runs a Fastify server and a Vue client, while Pi still owns the actual agent behavior:

- models come from Pi's model registry
- global agent resources come from `<batty-root>/.batty/`
- workspace agent resources come from `<workspace>/.batty/`
- instructions come from `<batty-root>/.batty/AGENTS.md` plus project `AGENTS.md`
- session history is stored in `<workspace>/.batty/sessions/`

Batty adds a browser-native layer on top:

- workspace and session browsing
- streaming transcript UI
- local caching and drafts
- push notifications
- cron
- subagents
- web search
- passkey login

## Quick start

Create a Batty root directory. Batty stores its own state in `<batty-root>/.batty/` and lists workspaces from the configured `workspacesRoots`.

Example options file:

`<batty-root>/.batty/options.json`

```json
{
  "authSecret": "generated-on-first-run",
  "workspacesRoots": ["/path/to/workspaces"],
  "webPushSubject": "https://your-batty-host",
  "braveSearchKey": "optional-brave-search-api-key"
}
```

Required fields:

- `workspacesRoots`
- `webPushSubject`

`authSecret` is generated automatically if missing.

### Local development

```bash
pnpm install
pnpm dev -- /path/to/batty-root
```

- client: `http://127.0.0.1:5173`
- server: `http://127.0.0.1:3147`

### Production-style run

```bash
pnpm build
pnpm start -- /path/to/batty-root
```

On first boot with no registered passkeys, Batty prints a one-time setup code in the server terminal.

The production build output lives in `dist/`, but the deployment flow packages a self-contained install directory that includes:

- `dist/client`
- `dist/server`
- `node_modules`
- `README.md`
- `package.json`
- `pnpm-lock.yaml`

## Authentication

Batty uses passkeys for passwordless login.

First device setup:

1. Start Batty.
2. Copy the setup code printed in the server terminal.
3. Open Batty in the browser.
4. Enter the setup code and register a passkey.

After that, sign-in uses the passkey directly.

To enroll another device later, generate a fresh setup code with the Batty CLI:

```bash
batty --root /path/to/batty-root auth code
```

## Batty CLI

Batty includes a small CLI for auth and cron jobs.

After deployment, `./scripts/deploy.sh` installs it as:

```bash
batty --root /path/to/batty-root <command>
```

For local repo usage before deployment, the equivalent command is:

```bash
pnpm batty -- --root /path/to/batty-root <command>
```

### Commands

```text
batty auth code
batty cron list [--workspace ID] [--json]
batty cron add --workspace ID --prompt TEXT --model ID --thinking LEVEL (--in DUR | --at ISO | --every DUR | --cron EXPR) [--tz IANA] [--session new|daily-inline|daily-detached] [--daily-context include|omit]
batty cron edit <jobId> [--workspace ID] [--prompt TEXT] [--model ID] [--thinking LEVEL] [--in DUR | --at ISO | --every DUR | --cron EXPR] [--tz IANA] [--session new|daily-inline|daily-detached] [--daily-context include|omit]
batty cron rm <jobId>
```

### Examples

```bash
batty --root /path/to/batty-root auth code
batty --root /path/to/batty-root cron list --workspace batty
batty --root /path/to/batty-root cron add --workspace batty --prompt "Check CI and summarize failures" --model openai-codex/gpt-5.6-sol --thinking medium --every 1h --session daily-detached --daily-context include
batty --root /path/to/batty-root cron add --workspace batty --prompt "Morning summary" --model openai-codex/gpt-5.6-sol --thinking low --cron "0 8 * * 1-5" --tz Europe/Copenhagen --session daily-inline
batty --root /path/to/batty-root cron edit <jobId> --prompt "Updated prompt"
batty --root /path/to/batty-root cron rm <jobId>
```

The same cron functionality is also available to the agent through Batty's built-in `cron` tool.

## Cron

Batty can run future agent turns in any workspace.

Schedules supported by both the CLI and the built-in tool:

- one-shot at a specific time
- one-shot after a relative duration like `10m` or `2h`
- repeating interval schedules like `1h` or `1d`
- cron expressions with an optional timezone
- session mode `new`, `daily-inline`, or `daily-detached`
- daily-detached context mode `include` or `omit`

If `--tz` / `timezone` is omitted for a cron expression, Batty uses the server's local timezone.

Daily session reuse keeps one cron conversation per workspace day. `daily-inline` runs directly in that daily session like a regular session turn. `daily-detached` runs are stored as `subagent` tool calls in that session. Daily-detached runs start fresh from the workspace system prompts by default. `--daily-context include` / `session.includePreviousContext=true` reuses earlier daily-session context for daily-detached jobs. The day rollover defaults to `04:00` local time and can be changed in `options.json`.

Cron job state includes:

- next scheduled run
- last run time
- last status
- last error
- last session id

The chat header also includes a cron popover for browsing, editing prompt/model/thinking level/session mode, and deleting existing jobs.

## Useful commands

```bash
pnpm check
pnpm test
pnpm build
pnpm start -- /path/to/batty-root
batty --root /path/to/batty-root auth code
```

## Configuration

### Runtime environment variables

- `BATTY_HOST` — bind host, defaults to `127.0.0.1`
- `BATTY_PORT` — bind port, defaults to `3147`

### Persisted options

Batty reads persisted server options from:

`<batty-root>/.batty/options.json`

Fields:

- `authSecret` — cookie signing secret, generated if missing
- `workspacesRoots` — required roots containing workspace folders
- `webPushSubject` — required VAPID subject; use a real `https:` origin or valid `mailto:` URI
- `cronDailySessionStartTime` — local rollover time for daily cron session reuse, formatted as `HH:MM`; defaults to `04:00`
- `braveSearchKey` — optional Brave Search API key used by Batty's built-in `web-search` tool
- `appTitle` — installation title shown in the UI, browser title, and PWA manifest; defaults to `Batty`
- `appColor` — installation color used for light and dark app chrome; one of `neutral`, `blue`, `teal`, `green`, `amber`, `rose`, or `violet`
- `defaultProvider` — optional default Pi model provider for new sessions, such as `openai-codex`
- `defaultModel` — optional default Pi model ID for new sessions, such as `gpt-5.6-sol`
- `defaultThinkingLevel` — optional default reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`

Example model defaults:

```json
{
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.6-sol",
  "defaultThinkingLevel": "medium"
}
```

Other global Pi settings can be placed in `<batty-root>/.batty/settings.json`. Model defaults in that file are ignored because `options.json` is authoritative. A workspace can override model defaults and other Pi settings in `<workspace>/.batty/settings.json`.

### Loaded environment file

If present, Batty also loads:

`<batty-root>/.batty/environment.json`

This file provides environment variables at server startup and is loaded again before every Pi `bash` tool invocation, so added or updated values are available to subsequent commands without restarting Batty.

### State directory contents

Batty stores local state in `<batty-root>/.batty/`, including:

- `options.json`
- `environment.json`
- `passkeys.json`
- `setup-code.json`
- `uploads/`
- `cron/jobs.json`
- `web-push/vapid-keys.json`
- `web-push/subscriptions.json`

## Notes on files and sessions

- Workspaces are direct child directories under the configured `workspacesRoots`.
- New workspaces created in the UI are created under the selected root.
- Uploaded files are staged on disk before being handed to Pi.
- Non-image attachments are injected into the prompt as `<file>` blocks.
- Image attachments are sent as image inputs and also referenced as file placeholders.
- Session state is kept in Pi's session files, with Batty caching recent snapshots locally in the browser.

## Hot reloading Batty itself

When working inside the Batty repo, use:

```bash
./scripts/reload-self.sh
```

That flow is designed to let the current agent turn finish cleanly before the service reload happens.

## Deployment

Repo includes:

- `deploy/batty.service` — systemd unit
- `deploy/batty.nginx.conf` — nginx example
- `scripts/deploy.sh` — build, package, install, and reload helper

Deploy on Linux with the project script:

```bash
sudo ./scripts/deploy.sh
```

The Linux deploy script installs Batty to `/opt/batty`:

- versioned releases under `/opt/batty/releases/<git-sha>`
- current install symlink at `/opt/batty/current`
- systemd `WorkingDirectory=/opt/batty/current`
- service entrypoint `/opt/batty/current/dist/server/main.mjs`
- CLI entrypoint `/opt/batty/current/dist/server/cli.mjs`

### macOS deployment with launchd

Run the deployment as the macOS login user, without `sudo`:

```bash
./scripts/deploy-macos.sh
```

The defaults use `~/Github` as both the Batty root and the workspace root. Override them when needed:

```bash
BATTY_ROOT="$HOME/Batty" \
BATTY_WORKSPACES_ROOT="$HOME/Projects" \
./scripts/deploy-macos.sh
```

The script builds and validates Batty, installs versioned releases under `~/Library/Application Support/Batty/app`, creates the `se.roybot.batty` launch agent, and installs the `batty` CLI in `~/.local/bin`. Logs are written under `~/Library/Logs/Batty`. The local app is served at `http://localhost:3147`; use that hostname rather than the numeric loopback address so passkeys work.

On the first deployment, the script creates `<batty-root>/.batty/options.json` and starts Batty immediately. Later deployments hand the launchd reload to a delayed background process so an active Batty agent turn can finish cleanly.

### Windows deployment behind IIS

This repo also includes a Windows deployment flow that runs Batty behind IIS with the ASP.NET Core Module acting as the reverse proxy to the Node process.

Requirements:

- IIS site with HTTPS already configured
- ASP.NET Core Module V2 installed on the machine
- Node.js available at `node.exe`
- an elevated PowerShell session for the IIS application setup step

Example deployment for `https://t14-dt-pc1028.cbrain.net/batty`:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-windows.ps1 `
  -InstallRoot 'D:\Batty\app' `
  -BattyRoot 'D:\Batty\root' `
  -WorkspacesRoots 'D:\projects','D:\github','D:\gitea' `
  -PublicOrigin 'https://t14-dt-pc1028.cbrain.net' `
  -BaseUrl '/batty' `
  -SiteName 'Default Web Site' `
  -AppPath 'batty'
```

That flow:

- installs dependencies
- runs checks and a production build
- initializes `D:\Batty\root\.batty\options.json` when it does not exist
- packages a versioned release under `D:\Batty\app\releases\<git-sha>-<UTC-timestamp>`
- hands activation to a detached process with a 20-second delay
- updates `D:\Batty\app\current` as a junction after the delay
- writes `web.config` for IIS out-of-process hosting
- configures and reloads the IIS application automatically when run elevated
- preserves the configured identity when the IIS application pool already exists
- writes handoff output under `D:\Batty\app\deploy-logs`

The generated IIS app serves Batty from the configured subpath and forwards requests to the Node server through a launcher script that sets:

- `BATTY_HOST=127.0.0.1`
- `BATTY_PORT=%ASPNETCORE_PORT%`
- `BATTY_SELF_PATH=<install-root>\current`

If the main deploy script is run without elevation, finish the IIS step from an elevated PowerShell session:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\configure-iis-app.ps1 `
  -SiteName 'Default Web Site' `
  -AppPath 'batty' `
  -PhysicalPath 'D:\Batty\app\current'
```
