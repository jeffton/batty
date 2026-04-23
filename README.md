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
- Pi-installable `web-search` extension backed by the same shared implementation
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

Create a Batty root directory. Batty stores its own state in `<batty-root>/.batty/` and lists workspaces from the configured `workspacesRoot`.

Example options file:

`<batty-root>/.batty/options.json`

```json
{
  "authSecret": "generated-on-first-run",
  "workspacesRoot": "/path/to/workspaces",
  "webPushSubject": "https://your-batty-host",
  "braveSearchKey": "optional-brave-search-api-key"
}
```

Required fields:

- `workspacesRoot`
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

## Pi web-search extension

This repo ships the `web-search` tool as a Pi package extension as well.

Set a Brave Search API key in your shell before starting Pi:

```bash
export BRAVE_SEARCH_API_KEY="your-brave-search-api-key"
```

Install the Batty repo as a Pi package:

```bash
pi install https://github.com/jeffton/batty.git
```

For a one-off run without installing it globally or into the project:

```bash
pi -e https://github.com/jeffton/batty.git
```

Pi loads `extensions/web-search/index.ts` from this repo and registers the same shared web-search tool code that Batty uses.

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
batty cron add --workspace ID --prompt TEXT --thinking LEVEL (--in DUR | --at ISO | --every DUR | --cron EXPR) [--model ID] [--tz IANA] [--session new|daily-inline|daily-subagent] [--daily-context include|omit]
batty cron edit <jobId> [--workspace ID] [--prompt TEXT] [--model ID] [--thinking LEVEL] [--in DUR | --at ISO | --every DUR | --cron EXPR] [--tz IANA] [--session new|daily-inline|daily-subagent] [--daily-context include|omit]
batty cron rm <jobId>
```

### Examples

```bash
batty --root /path/to/batty-root auth code
batty --root /path/to/batty-root cron list --workspace batty
batty --root /path/to/batty-root cron add --workspace batty --prompt "Check CI and summarize failures" --thinking medium --every 1h --session daily-subagent --daily-context include
batty --root /path/to/batty-root cron add --workspace batty --prompt "Morning summary" --thinking low --cron "0 8 * * 1-5" --tz Europe/Copenhagen --session daily-inline
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
- session mode `new`, `daily-inline`, or `daily-subagent`
- daily-subagent context mode `include` or `omit`

If `--tz` / `timezone` is omitted for a cron expression, Batty uses the server's local timezone.

Daily session reuse keeps one cron conversation per workspace day. `daily-inline` runs directly in that daily session like a regular session turn. `daily-subagent` runs are stored as `subagent` tool calls in that session. Daily-subagent runs start fresh from the workspace system prompts by default. `--daily-context include` / `session.includePreviousContext=true` reuses earlier daily-session context for daily-subagent jobs. The day rollover defaults to `04:00` local time and can be changed in `options.json`.

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
- `workspacesRoot` — required root containing workspace folders
- `webPushSubject` — required VAPID subject; use a real `https:` origin or valid `mailto:` URI
- `cronDailySessionStartTime` — local rollover time for daily cron session reuse, formatted as `HH:MM`; defaults to `04:00`
- `braveSearchKey` — optional Brave Search API key used by Batty's built-in `web-search` tool

### Loaded environment file

If present, Batty also loads:

`<batty-root>/.batty/environment.json`

This file can provide environment variables before the server starts.

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

- Workspaces are direct child directories under `workspacesRoot`.
- New workspaces created in the UI are created directly under that root.
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
  -WorkspacesRoot 'D:\projects' `
  -PublicOrigin 'https://t14-dt-pc1028.cbrain.net' `
  -BaseUrl '/batty' `
  -SiteName 'Default Web Site' `
  -AppPath 'batty'
```

That flow:

- installs dependencies
- runs checks, tests, and a production build
- writes `D:\Batty\root\.batty\options.json`
- packages a versioned release under `D:\Batty\app\releases\<git-sha>`
- updates `D:\Batty\app\current` as a junction
- writes `web.config` for IIS out-of-process hosting
- configures the IIS application automatically when run elevated

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
