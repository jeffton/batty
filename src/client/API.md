# Client API

The authenticated root route contains one main chat. Workspace listings never select or replace this session.

## Main chat

- `GET /api/bootstrap`: existing `BootstrapPayload` auth/provider/settings/models fields. The client does not consume workspace snapshots or daily-session data.
- `GET /api/workspaces`: `{ workspaces: WorkspaceInfo[] }`.
- `GET /api/main`: `SessionState`, full latest message window.
- Main `SessionState.memoryPreparation` carries `{ pending, totalLeaves, builtLeaves, error? }` in initial snapshots and SSE updates. Pending work displays “Preparing memory”; errors remain visible and prompt submission remains enabled. `isCompacting` describes workers’ native compaction only. `GET /api/memory/status` exposes the same OptChat status for diagnostics.
- `GET /api/main/messages?before=<durable entry id>&limit=50`: `SessionMessagesPage`.
- `GET /api/main/events`: SSE JSON `ServerEvent`. Full reset snapshots merge overlapping messages while preserving paginated history. Durable entry IDs need not be numeric.
- `POST /api/main/prompt` and `POST /api/main/steer`: multipart `text`, `clientMessageId`, repeated `files`; return `{ disposition: 'started' | 'queued', submissionId, sessionId }`. Optimistic messages are removed after HTTP acceptance. On uncertain delivery, the restored draft retains its original `clientMessageId` for a deduplicated retry. State/queued `clientMessageId` mappings can confirm acceptance when an HTTP response is lost.
- `POST /api/main/stop`: `{ ok: true }`.
- `POST /api/main/queue/remove`: `{ kind, index }`, kind `steer` or `followUp`, index copied from the queued prompt's durable submission identifier; return `SessionState`.

## Read-only worker sessions

- `GET /api/sessions/:id`: `SessionState`.
- `GET /api/sessions/:id/messages?before=&limit=`: `SessionMessagesPage`.
- `GET /api/sessions/:id/events`: SSE `ServerEvent`.
- `GET /api/sessions/:id/resources`: `SessionResourcesResponse` (used for the main session too).
- `GET /api/sessions/:mainId/subagents`: `RunningSubagent[]`.
- `GET /api/workspaces/:id/cron-jobs`: `CronJob[]`.
- `GET /api/workspaces/:id/cron-run-logs`: `CronRunLog[]`.

Tool details `subagent.sessionId`, nested codemode `calls[].subagent.sessionId`, and custom-message `data.subagent.sessionId` / `data.cron.sessionId` identify transcripts. Cron log entries expose `sessionId` when a transcript exists. Worker popovers have no composer. Their header offers Stop while the session is active; `POST /api/sessions/:sessionId/stop` aborts the worker’s current delivery chain and queued tail.

## Shared cloud browser

A `SiteDescriptor` with `browserId` is a private live-browser attachment, rendered by `BrowserPopover` rather than a site iframe. Its opaque ID locates a browser instance; every API request still requires Batty authentication.

- `GET /api/cloud-browser/:browserId/state`: `CloudBrowserState` (active page, viewport, revision, tabs and focused editable field).
- `GET /api/cloud-browser/:browserId/events`: authenticated SSE `state`, `frame` (base64 JPEG + page/viewport revision) and terminal `browser-error` events. Closing the viewer stops streaming, not Chromium; background clients disconnect and reconnect when visible.
- `POST /api/cloud-browser/:browserId/control`: allowlisted `CloudBrowserControl`; requires a matching `Origin`, returns state. Pointer/text/key commands require the displayed page and revision. `fill-focused` also requires the focused field ID and replaces its value, including empty strings. Contextual Enter includes the same field ID so changed focus rejects submission. Viewer input preserves the revision/capture; agent actions, navigation and viewport changes invalidate it. Busy/stale requests return 409; expired handles return 410. Generic CDP/evaluation is unavailable.

Types are in `shared/cloud-browser.ts`; new viewer controls must also be added to the server schema.

## Existing settings/auth APIs

Existing shapes are consumed for models, provider usage, passkey auth, logout, provider auth, appearance/default model, Brave Search, environment variables, AGENTS.md, MCP settings/auth/status, and site visibility. Exact routes and request bodies are in `lib/api.ts`. MCP settings and connections are global, shared by all workspaces.
