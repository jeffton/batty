# Batty

A browser UI for [Pi Coding Agent](https://pi.dev) that keeps Pi's session/model/skill/config behavior, but moves the chat experience into a responsive web app.

## What ships

- Responsive Vue 3 UI with mobile sidebar
- Markdown rendering for assistant replies
- SSE streaming for live assistant output and tool activity
- Monospace multiline composer with drag/drop and `+` attachment picker
- Image rendering for message and tool output blocks
- Model selection powered by Pi's model registry
- Workspace picker for folders directly under a configured root
- Create new workspaces directly under the configured root from the sidebar
- Session listing + resume per workspace using Pi session files
- Offline-friendly client shell via PWA + IndexedDB snapshot caching
- Native Web Push notifications when agent runs finish in the background, including iOS Home Screen installs
- TypeScript Fastify server using Pi's SDK/session APIs
- Tests for auth, workspace discovery, and client session-event reduction

## Stack

- Vite+ `0.1.11`
- Vue `3.5.30`
- Vue Router `5.0.3`
- Pinia `3.0.4`
- TypeScript `5.9.3`
- Pi Coding Agent `0.60.0`
- Fastify `5.8.2`

## Auth

Batty now uses passkeys for passwordless auth on a single-user system. Passwords are gone.

Flow:

1. On first start with no registered passkeys, the server prints a one-time setup code in the terminal.
2. Open Batty in the browser, enter the setup code, and register a passkey with Face ID / Touch ID / Windows Hello.
3. Later logins use the passkey directly.
4. To add another device, print a fresh one-time setup code with `pnpm add-user -- /path/to/batty-root`.

Batty reads its persisted server config from `<batty-dir>/.batty/options.json`, where `<batty-dir>` is passed as a command line argument when starting the server. On this server that path is `/root/github/.batty/options.json`.

- `workspacesRoot` is required
- `webPushSubject` is required
- `authSecret` is generated automatically if missing, then persisted
- registered passkeys are stored in `<batty-dir>/.batty/passkeys.json`
- active one-time setup codes are stored in `<batty-dir>/.batty/setup-code.json`
- sign-in and setup-code verification are rate-limited in memory to roughly 5 failed attempts per minute per client IP

Example:

```json
{
  "authSecret": "generated-on-first-run",
  "workspacesRoot": "/root/github",
  "webPushSubject": "https://batty.roybot.se"
}
```

That `<batty-dir>/.batty/` directory is ignored by git and is intended to hold local state such as:

- `options.json`
- `uploads/`
- `web-push/vapid-keys.json`
- `web-push/subscriptions.json`

## Local development

```bash
pnpm install
pnpm dev -- /path/to/batty-root
```

App UI: `http://127.0.0.1:5173`

API server: `http://127.0.0.1:3147`

On a fresh checkout, create `/path/to/batty-root/.batty/options.json` with the required fields before starting the server. On first boot the server will print a setup code for registering the first passkey.

## Useful commands

```bash
pnpm check
pnpm test
pnpm build
pnpm start -- /path/to/batty-root
pnpm add-user -- /path/to/batty-root
```

## Configuration

Runtime env vars are intentionally minimal:

- `BATTY_HOST` - server bind host, default `127.0.0.1`
- `BATTY_PORT` - server port, default `3147`

Persisted server options live in `<batty-dir>/.batty/options.json`:

- `authSecret` - cookie signing secret, generated if missing
- `workspacesRoot` - required root directory containing workspace folders
- `webPushSubject` - required VAPID subject; use a real `https:` origin or valid `mailto:` URI

Pi resources are loaded from the regular `~/.pi` setup through Pi's SDK:

- models: `~/.pi/agent/models.json`
- skills: `~/.pi/agent/skills`
- settings: `~/.pi/agent/settings.json`
- AGENTS.md: `~/.pi/agent/AGENTS.md` plus project `AGENTS.md`

## Hot reloading Batty itself

When you open a session in this repo's workspace, the agent can modify this repo directly and restart the deployed app with:

```bash
scripts/reload-self.sh
```

Pi session state is persisted in Pi's session files, and the web app also caches the latest session snapshot in IndexedDB, so reconnecting after a rebuild/restart is cheap.

## Deployment

Repo includes:

- `deploy/batty.service` - systemd unit
- `deploy/batty.nginx.conf` - nginx reverse proxy for `batty.roybot.se`
- `scripts/deploy.sh` - install/build/restart helper; the bundled systemd unit starts the server with `/root/github` as the Batty state root on this server

Deploy on the server:

```bash
sudo certbot certonly --webroot -w /var/www/default -d batty.roybot.se
sudo ./scripts/deploy.sh
```

## Notes

- This is intentionally not backwards-compatible with older Pi/Vite stacks.
- Attachments are staged on disk before being handed to Pi.
- Non-image files are injected into the prompt as `<file>` blocks; image files are sent as model image inputs.
