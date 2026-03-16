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
- Pi Coding Agent `0.58.1`
- Fastify `5.8.2`

## Auth

For now auth is a hardcoded password in `src/server/config.ts`:

```txt
pi-face-d3mQm4Hc-9rY2Qv7-7nLk
```

Set `PI_FACE_PASSWORD` to override it in production.

## Local development

```bash
pnpm install
pnpm dev
```

App UI: `http://127.0.0.1:5173`

API server: `http://127.0.0.1:3147`

## Useful commands

```bash
pnpm check
pnpm test
pnpm build
pnpm start
```

## Configuration

Environment variables:

- `PI_FACE_HOST` - server bind host, default `127.0.0.1`
- `PI_FACE_PORT` - server port, default `3147`
- `PI_FACE_WORKSPACES_DIR` - root directory containing workspace folders, default `~/github`
- `PI_FACE_PASSWORD` - overrides the hardcoded password
- `PI_FACE_SECRET` - cookie signing secret
- `PI_FACE_UPLOADS_DIR` - attachment staging directory
- `PI_FACE_WEB_PUSH_DIR` - persistent storage for VAPID keys and push subscriptions
- `PI_FACE_WEB_PUSH_SUBJECT` - VAPID subject, must be a real `https:` origin or valid `mailto:` URI; default `https://pi.roybot.se`
- `PI_FACE_WEB_PUSH_PUBLIC_KEY` - optional explicit VAPID public key override
- `PI_FACE_WEB_PUSH_PRIVATE_KEY` - optional explicit VAPID private key override

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
