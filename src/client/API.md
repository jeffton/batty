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

The `sites` attachment envelope contains a discriminated `SiteAttachmentDescriptor` union: `SiteDescriptor` (`kind: "site"`) or `BrowserDescriptor` (`kind: "browser"`, required `browserId`, `public: false`). A browser is rendered by `BrowserPopover` rather than a site iframe. Its opaque ID locates a browser instance; every API request still requires Batty authentication.

- `GET /api/cloud-browser/:browserId/state`: `CloudBrowserState` (active page, viewport, revision, tabs and focused editable field).
- `GET /api/cloud-browser/:browserId/socket`: authenticated, same-origin WebSocket. Text messages are `{event,data}` for state/errors and `scroll-drained`. Binary frames contain a 4-byte big-endian JSON-header length, `{frameId,pageId,revision,width,height,codec,key,streamId}`, then an Annex-B H.264 access unit. Width/height are CSS coordinates; encoded dimensions are even-rounded. `streamId` identifies an encoder lifetime. Decoders start on a keyframe and reset on a new stream/view; parameter sets accompany keyframes. Viewers ACK presented/discarded frame IDs. Four frames can be outstanding; the queue holds at most eight access units/2 MiB and drops a dependent GOP on overflow, waiting for a keyframe. There is no JPEG transport fallback. Scroll commands use CSS coordinates and `{action:"flush",requestId}` orders later HTTP controls after prior scrolling. Transient failures reconnect with backoff; 410 stays closed. This replaces the JPEG packet payload and the SSE `/events` endpoint. Native video requires a Linux host; incompatible existing headless processes return 426 without replacing the browser or login.
- `POST /api/cloud-browser/:browserId/control`: allowlisted `CloudBrowserControl`; requires a matching `Origin`, returns state. Pointer/text/key commands require the displayed page and revision. `fill-focused` also requires the focused field ID and replaces its value, including empty strings. Contextual Enter includes the same field ID so changed focus rejects submission. Viewer input preserves the revision/capture; agent actions, navigation and viewport changes invalidate it. Busy/stale requests return 409; expired handles return 410. `viewport` requires `{width,height,mobile}` in viewer CSS pixels and accepts `deviceScaleFactor` (1–3, default 1); it applies device/screen metrics, touch, UA and client hints. Native capture supports at most 1365 CSS pixels in either dimension. A mobile/desktop mode change reloads the same page; size-only changes do not. Generic CDP/evaluation is unavailable.

Types are in `shared/cloud-browser.ts`; new viewer controls must also be added to the server schema.

## Existing settings/auth APIs

Existing shapes are consumed for models, provider usage, passkey auth, logout, provider auth, appearance/default model, Brave Search, environment variables, AGENTS.md, MCP settings/auth/status, and site visibility. Exact routes and request bodies are in `lib/api.ts`. MCP settings and connections are global, shared by all workspaces.
