# Runtime, memory and integrations

## Conversation and workers

There is one permanent main conversation. Workspaces supply execution directories and instructions for workers and scheduled work; they are not separate user chats.

Pi Durable persists the main conversation, linear workers, queued input and report delivery in SQLite. Main-started subagents run asynchronously. Workers can use synchronous helpers or parallel async helpers with `run`, `await`, `queue`, `resume`, `steer` and `stop`. Reports return to the spawning parent. In main, `await` yields the turn for later result delivery; in a worker or cron turn, it joins a direct child and returns its final result without a duplicate report. Other helper reports wait until joined or the parent turn finishes.

Cron supports main-inline execution and detached workers. `daily-inline` and `daily-detached` are accepted names targeting the permanent main thread, not daily sessions. Delivery can go through the assistant or directly to the user. Detached helpers stay with their cron parent; only the completed cron turn's final output is delivered onward.

Outgoing prompts appear immediately, including attachment names, and survive refresh until the server publishes the matching message. Failed submissions restore the draft; cancelling queued input removes its outgoing entry.

## Memory

OptChat retains originals and builds immutable binary summaries. Each main run pins a published summary prefix plus the newer uncompressed text projections, followed by its own input and tool loop. Normal requests do not wait for background compression. A raw backlog exceeding the memory-view byte budget waits for compression before the request is sent. `memory_zoom` expands child summaries or retrieves original non-thought text; `memory_date` retrieves an original entry's timestamp; `memory_search` uses FTS5 to search original text by 1–12 literal words, newest first. Tool calls and results are excluded from search unless requested. Full metadata, images and reasoning remain in the permanent archive; reasoning is excluded from compression.

Packets persist the exact view, input boundary, generation and covered message counts for retry and restart. Compression runs on a separate writer queue; complete prefixes publish through short, atomic generation/checkpoint-checked commits. Repairs publish child generations with unchanged nodes inherited from the previous prefix, so pinned zooms retain their tree. Completed nodes and checkpoints survive restart; an interrupted inference without a committed node may repeat.

Fresh workers targeting the assistant workspace receive main memory and pin their overview and generation on the first model request for their lifetime. Copied-context workers retain their copied snapshot; workers in other workspaces receive no main-memory overview or navigation tools. Pi Durable compacts worker context while retaining original history. Main-inline cron uses OptChat; main declines native compaction.

Settings → Memory controls the summarization model and free-text language. The defaults are `openai-codex/gpt-6-luna` and English. `BATTY_MEMORY_REASONING` controls reasoning; `BATTY_MEMORY_MODEL` is not used. Changing language does not rewrite existing summaries or original messages. `scripts/prepare-memory.ts` prepares memory without starting HTTP.

### Usage accounting

OptChat requests lead with effective instructions and tool declarations. Authenticated `GET /api/memory/usage` separates incremental and rebuild totals: attempts, measured/unmeasured outcomes, uncached input, cache reads/writes, output, reasoning and API-equivalent catalog cost. Reasoning is included in output, not added to it. This measures returned API usage, not subscription spending. Coverage starts with instrumentation; historical compression costs and provider-internal retries without returned usage are not recorded.

The durable `batty.memory-usage` document stores totals. `batty.memory-call` entries in `runtime.sqlite` hold per-attempt operation, generation/node range, source hash, model, timing, stop reason, response ID and returned usage. They contain no source text or provider error messages and do not enter the memory tree or conversational usage totals.

## MCP and codemode

MCP uses one `.batty/mcp.json` configuration and a shared connection registry across workspaces. Stdio servers run from the configured data root; use absolute paths for workspace resources. MCP tools are discovered and called through codemode, which runs JavaScript in a QuickJS sandbox and can compose ordinary tools as well.

Settings use `/api/settings/mcp`; connection status and actions use `/api/mcp`. Workspace-specific MCP configuration, overrides and scoped API parameters are not supported.

## Browser lifecycle

Detached browser instances and tabs survive Batty restarts. Every conversation's browser expires after **60 minutes without browser activity**, including main and interrupted workers. Active and queued browser calls are protected during cleanup. Expiry runs at startup and each minute without resetting the persisted inactivity clock. Explicit stop closes the matching worker browser. After expiry, `browser open` starts a new instance.

### Shared cloud browser

`browser({action: "open", url: "https://example.com", cloud: true})` enables interactive VPS access and attaches a private live-browser button; `browser({action: "attach"})` attaches that same browser again. It opens a popover, not a local browser session or a copy of cookies. Agent and human share the same Chromium pages, login and live state. Ordinary tool calls have no shared viewer by default. On Linux their persistent Chromium process uses a private authenticated X display so a viewer can attach to the same process later. Before viewing, a new cloud browser uses a 390 × 640 viewport unless specified. The viewer matches its available area in CSS pixels and requests the display’s pixel density, up to 3×. Touch/mobile viewers use mobile Chromium device metrics, screen size, touch support, user-agent and client hints; desktop viewers use desktop emulation. Rotation/resizing keeps the page alive. Switching between mobile and desktop reloads the existing page for server-selected layouts while preserving cookies, storage and login. Opening the phone keyboard keeps the remote layout stable.

The popover shows one page with its address in the header; bare domains use HTTPS and focusing the address selects the full URL. Popups become the visible page, and Back returns to the opener when the popup has no history. Agent tab/drag/key controls remain available through the browser tool. Touch swipes and mouse wheels scroll the remote element under the pointer, including nested containers. Focusing an editable field reveals a local keyboard editor; changes replace the remote value, and Enter submits single-line fields. Native H.264 capture targets 30 frames/s, bounded by transport and presentation credits. Scrolling uses up to 2× density; capture returns to requested density after 150 ms wheel idle or one second after touch release to cover momentum. Viewing counts as browser activity. Closing/backgrounding the viewer disconnects streaming without closing Chromium. Transport interruptions and transient navigation/capture errors reconnect automatically with backoff, capped at 15 seconds. Expired/closed browsers remain closed; other permanent errors offer manual retry without creating a new browser. `action: "close"` or idle expiry permanently invalidates its handles. Attachments survive service restarts and can be explicitly forwarded with their `browser:` artifact refs. Forwarding preserves the same live session and expiry; it does not publish access or open another browser. See [response artifacts](artifacts.md).

FFmpeg captures the private X display and encodes H.264, delivered through Batty's authenticated binary WebSocket. WebCodecs decodes into the viewer canvas. Each viewer has at most four unacknowledged frames and a bounded GOP-aware queue; overflow discards the dependent frames and waits for a periodic keyframe. There is no JPEG fallback. Native capture requires Linux, Xvfb, xauth and FFmpeg with x11grab/libx264. Viewports support at most 1365 CSS pixels per dimension. Existing headless browser processes retain their login and tabs but cannot be viewed through this transport; replacing one requires an explicit close/open. Scroll input uses the same socket, with an ordering fence before HTTP controls such as clicks. Controls are same-origin, allowlisted HTTP commands serialized with agent actions; busy operations and stale-view input are rejected. No desktop, extra public port, iframe capability link or public-sharing option is exposed. Local iPhone passkeys, clipboard and file pickers are not forwarded.

## Offline reading

The main thread opens from an authentication-scoped IndexedDB cache before network requests. It fills at least the latest 24 hours, retaining up to seven days within a 32 MiB soft budget, and reports an error rather than exceeding 128 MiB or dropping the latest day. Quota failures preserve the previous complete cache. Logout invalidates cached reading across tabs. Worker sessions are excluded, but their main-thread notices remain.

Reconnect uses the last durable message ID and an inclusive overlap record, updating existing IDs and live state without resending the entire conversation. Older history loads in pages. Sending requires a live connection; offline drafts are not queued for delivery.

Images use lazy 768-pixel WebP previews with links to originals. The service worker stores up to 128 private previews per authentication scope. Historical rows are virtualized; eight tail rows stay mounted. See [operations](operations.md#checks) for the production offline check.
