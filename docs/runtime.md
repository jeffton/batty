# Runtime, memory and integrations

## Conversation and workers

There is one permanent main conversation. Workspaces supply execution directories and instructions for workers and scheduled work; they are not separate user chats.

Pi Durable persists the main conversation, linear workers, queued input and report delivery in SQLite. Main-started subagents run asynchronously. Workers can use synchronous helpers or parallel async helpers with `run`, `await`, `queue`, `resume`, `steer` and `stop`. Reports return to the spawning parent. In main, `await` yields the turn for later result delivery; in a worker or cron turn, it joins a direct child and returns its final result without a duplicate report. Other helper reports wait until joined or the parent turn finishes.

Cron supports main-inline execution and detached workers. `daily-inline` and `daily-detached` are accepted names targeting the permanent main thread, not daily sessions. Delivery can go through the assistant or directly to the user. Detached helpers stay with their cron parent; only the completed cron turn's final output is delivered onward.

Outgoing prompts appear immediately, including attachment names, and survive refresh until the server publishes the matching message. Failed submissions restore the draft; cancelling queued input removes its outgoing entry.

## Memory

OptChat retains originals and builds immutable binary summaries. Each main run receives a frozen overview plus its own tool loop. `memory_zoom` expands child summaries or retrieves original non-thought text; `memory_date` retrieves an original entry's timestamp; `memory_search` uses FTS5 to search original text by 1–12 literal words, newest first. Tool calls and results are excluded from search unless requested. Full metadata, images and reasoning remain in the permanent archive; reasoning is excluded from compression.

Fresh workers targeting the assistant workspace receive main memory and pin their overview on the first model request for their lifetime. Copied-context workers retain their copied snapshot; workers in other workspaces receive no main-memory overview or navigation tools. Pi Durable compacts worker context while retaining original history. Main-inline cron uses OptChat; main declines native compaction.

Settings → Memory controls the summarization model and free-text language. The defaults are `openai-codex/gpt-6-luna` and English. `BATTY_MEMORY_REASONING` controls reasoning; `BATTY_MEMORY_MODEL` is not used. Changing language does not rewrite existing summaries or original messages. `scripts/prepare-memory.ts` prepares memory without starting HTTP.

### Usage accounting

OptChat requests lead with effective instructions and tool declarations. Authenticated `GET /api/memory/usage` separates incremental and rebuild totals: attempts, measured/unmeasured outcomes, uncached input, cache reads/writes, output, reasoning and API-equivalent catalog cost. Reasoning is included in output, not added to it. This measures returned API usage, not subscription spending. Coverage starts with instrumentation; historical compression costs and provider-internal retries without returned usage are not recorded.

The durable `batty.memory-usage` document stores totals. `batty.memory-call` entries in `runtime.sqlite` hold per-attempt operation, generation/node range, source hash, model, timing, stop reason, response ID and returned usage. They contain no source text or provider error messages and do not enter the memory tree or conversational usage totals.

## MCP and codemode

MCP uses one `.batty/mcp.json` configuration and a shared connection registry across workspaces. Stdio servers run from the configured data root; use absolute paths for workspace resources. MCP tools are discovered and called through codemode, which runs JavaScript in a QuickJS sandbox and can compose ordinary tools as well.

Settings use `/api/settings/mcp`; connection status and actions use `/api/mcp`. Workspace-specific MCP configuration, overrides and scoped API parameters are not supported.

## Browser lifecycle

Detached browser instances and tabs survive Batty restarts. Every conversation's browser expires after **60 minutes without browser activity**, including main and interrupted workers. Active and queued browser calls are protected during cleanup. Expiry runs at startup and each minute without resetting the persisted inactivity clock. Explicit stop closes the matching worker browser. After expiry, `browser open` starts a new instance.

## Offline reading

The main thread opens from an authentication-scoped IndexedDB cache before network requests. It fills at least the latest 24 hours, retaining up to seven days within a 32 MiB soft budget, and reports an error rather than exceeding 128 MiB or dropping the latest day. Quota failures preserve the previous complete cache. Logout invalidates cached reading across tabs. Worker sessions are excluded, but their main-thread notices remain.

Reconnect uses the last durable message ID and an inclusive overlap record, updating existing IDs and live state without resending the entire conversation. Older history loads in pages. Sending requires a live connection; offline drafts are not queued for delivery.

Images use lazy 768-pixel WebP previews with links to originals. The service worker stores up to 128 private previews per authentication scope. Historical rows are virtualized; eight tail rows stay mounted. See [operations](operations.md#checks) for the production offline check.
