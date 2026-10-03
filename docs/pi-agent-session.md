# Pi Durable integration

The `experiment/pi-durable` branch uses Pi Durable 1.0.0 for generation, admission, persistent queues, retries, compaction, and tool scheduling. No coding-agent SDK session or agent loop is created.

## Ownership

- `SessionStore` owns one Durable Harness, conversation, writer lock, and `.sqlite` file per session. Durable records are the sole persisted history and execution state.
- `DurableAgentSessionController` adapts native conversation operations, resource hooks, and receipt-aware settlement. Native documents own live state.
- `SessionResources` owns model/auth services, resource loading, tool loadouts, and Pi's standalone extension runner. Built-in codemode, tool search, and MCP use this host.
- `session-projection.ts` translates Durable entries into existing UI DTOs in memory. Listing, search, pagination, images, and artifacts read the same store.
- Batty manages cron and subagent orchestration. Each child has its own Harness; host completion receipts commit before settlement can dispose an ephemeral child.

Readers observe committed entries before completion notifications. Follow-ups finish before settlement, and resource reloads wait for the settled boundary.

## Browser state

HTTP and each SSE connection start with a `SessionSnapshot`: native live, inbox, agent, and usage documents plus a separate historical message window. SSE updates carry native Chord document operations; there is no replay log or assistant/tool delta reducer. The client stores the raw snapshot and derives presentation in one adapter.

History reads are bounded by the stream's committed entry identity. HTTP responses cannot replace an active stream's document base or introduce future history. Tool results join native slots by entry identity, not reusable provider call IDs. Queue withdrawal addresses native submission IDs.

`SessionStore` hydrates committed entries and submissions once, then adopts commit publications into its read index. Unchanged history and context usage are reused across progress frames.

## Tools and resources

Image reading, tracked writes, shell session metadata, MCP status/OAuth, codemode, and tool search retain their Batty behavior. Commands, skills, templates, prompt construction, and request-context transforms use independent resource services.

Tools are unsafe to replay: interrupted calls produce error results rather than repeat side effects. Codemode is one Durable tool task; nested calls use the resource host's validation, hooks, and concurrency policy. Bounded nested progress is published through the outer native tool's details. Artifact receipts capture the exact outer task identity, including late cancellation results, and decorate presentation copies without changing model context.

Regular tool preferences are separate from Durable model declarations. Deferred MCP tools remain callable through codemode; loadout preparation controls model-visible declarations and descriptions.

Durable determines compaction's retained context boundary. Resource hooks can cancel compaction or supply a summary, but cannot select another cut.

[MCP settings](mcp.md) describe scoped configuration and the web-management UI.

## Lifecycle and format changes

- `.sqlite` is the session format. Existing JSONL histories and experimental sidecars are not imported or listed; data migration is a separate task.
- Client message IDs deduplicate admission. Steering and follow-up queues survive process replacement.
- `abort()` withdraws queued inputs and stops work. `dispose()` checkpoints unfinished work for recovery.
- Resources and tools are installed before recovered tasks resume.
- Failed/interrupted assistants remain visible in the transcript but are excluded from provider context by Durable.

Detached deployment workers run the prepared CLI’s `drain` checkpoint command before restart. The initiating tool’s `PI_SESSION_FILE` and `PI_RESTART_AFTER_ENTRY_ID` are passed as `--session` and `--after-entry`; only the exact initiating response’s persisted final summary is awaited, not later follow-ups. Other active sessions are disposed with durable checkpoints and recover after restart, including queues, subagents, and result delivery.

## Dependencies and validation

Pi AI, agent-core, coding-agent, Durable, and Chord are pinned to 1.0.0. The coding-agent patch exposes pure prompt builders and accepts a readonly session view in `ExtensionRunner`; it does not introduce another execution engine.

Tests cover durable recovery, unsafe-tool cancellation, queues, deduplication, compaction, forks, SQLite readers, MCP reloads, nested artifacts, and detached result delivery.
