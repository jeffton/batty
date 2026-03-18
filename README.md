# pi-face

A browser UI for [Pi Coding Agent](https://pi.dev) that keeps Pi's session/model/skill/config behavior, but moves the chat experience into a responsive web app.

## What ships

- Responsive Vue 3 UI with mobile sidebar
- Markdown rendering for assistant replies
- SSE streaming for live assistant output and tool activity
- Monospace multiline composer with drag/drop and `+` attachment picker
- Image rendering for message and tool output blocks
- Model selection powered by Pi's model registry
- Workspace picker for folders directly under a configured root, plus a dedicated `pi-face` self-workspace
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

pi-face reads its persisted server config from `.pi-face/options.json`.

- `username` is required
- `password` is required
- `workspacesRoot` is required
- `webPushSubject` is required
- `authSecret` is generated automatically if missing, then persisted
- `/api/login` is rate-limited in memory to roughly 5 failed attempts per minute per client IP

Example:

```json
{
  "username": "david",
  "password": "set-a-real-password-here",
  "authSecret": "generated-on-first-run",
  "workspacesRoot": "/root/github",
  "webPushSubject": "https://pi.roybot.se"
}
```

`.pi-face/` is ignored by git and is intended to hold local state such as:

- `options.json`
- `uploads/`
- `web-push/vapid-keys.json`
- `web-push/subscriptions.json`

## Local development

```bash
pnpm install
pnpm exec tsx scripts/migrate-state.ts
pnpm dev
```

App UI: `http://127.0.0.1:5173`

API server: `http://127.0.0.1:3147`

On a fresh checkout, `scripts/migrate-state.ts` will create `.pi-face/options.json` if needed, generate `authSecret`, and then fail until the required fields are filled in.

## Useful commands

```bash
pnpm check
pnpm test
pnpm build
pnpm start
```

## Configuration

Runtime env vars are intentionally minimal:

- `PI_FACE_HOST` - server bind host, default `127.0.0.1`
- `PI_FACE_PORT` - server port, default `3147`

Persisted server options live in `.pi-face/options.json`:

- `username` - required login username
- `password` - required login password
- `authSecret` - cookie signing secret, generated if missing
- `workspacesRoot` - required root directory containing workspace folders
- `webPushSubject` - required VAPID subject; use a real `https:` origin or valid `mailto:` URI

Pi resources are loaded from the regular `~/.pi` setup through Pi's SDK:

- models: `~/.pi/agent/models.json`
- skills: `~/.pi/agent/skills`
- settings: `~/.pi/agent/settings.json`
- AGENTS.md: `~/.pi/agent/AGENTS.md` plus project `AGENTS.md`

## Hot reloading pi-face itself

When you open a session in the `pi-face` workspace, the agent can modify this repo directly and restart the deployed app with:

```bash
scripts/reload-self.sh
```

That script also runs the one-time state migration from `.data/` to `.pi-face/` before rebuilding.

Pi session state is persisted in Pi's session files, and the web app also caches the latest session snapshot in IndexedDB, so reconnecting after a rebuild/restart is cheap.

## Deployment

Repo includes:

- `deploy/pi-face.service` - systemd unit
- `deploy/pi-face.nginx.conf` - nginx reverse proxy for `pi.roybot.se`
- `scripts/deploy.sh` - install/build/restart helper

Deploy on the server:

```bash
sudo ./scripts/deploy.sh
sudo certbot --nginx -d pi.roybot.se
```

## Notes

- This is intentionally not backwards-compatible with older Pi/Vite stacks.
- Attachments are staged on disk before being handed to Pi.
- Non-image files are injected into the prompt as `<file>` blocks; image files are sent as model image inputs.
