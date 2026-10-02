# Pi Durable integration

The `experiment/pi-durable` branch uses Pi Durable 1.0.0 for generation, admission, persistent queues, retries, compaction, and tool scheduling. No coding-agent SDK session or agent loop is created.

## Ownership

- `SessionStore` owns one Durable Harness, conversation, writer lock, and `.sqlite` file per session. Durable records are the sole persisted history and execution state.
- `DurableAgentSessionController` implements Batty's session contract and translates committed events into its web protocol.
- `SessionResources` owns model/auth services, resource loading, tool loadouts, and Pi's standalone extension runner. Built-in codemode, tool search, and MCP use this host.
- `session-projection.ts` translates Durable entries into existing UI DTOs in memory. Listing, search, pagination, images, and artifacts read the same store.
- Batty manages cron and subagent orchestration. Each child has its own Harness; host completion receipts commit before settlement can dispose an ephemeral child.

Readers observe committed entries before completion notifications. Follow-ups finish before settlement, and resource reloads wait for the settled boundary.

## Tools and resources

Image reading, tracked writes, shell session metadata, MCP status/OAuth, codemode, and tool search retain their Batty behavior. Commands, skills, templates, prompt construction, and request-context transforms use independent resource services.

Tools are unsafe to replay: interrupted calls produce error results rather than repeat side effects. Codemode is one Durable tool task; nested calls use the resource host's validation, hooks, progress events, and concurrency policy. Artifact receipts capture the exact outer task identity, including late cancellation results, and decorate presentation copies without changing model context.

Regular tool preferences are separate from Durable model declarations. Deferred MCP tools remain callable through codemode; loadout preparation controls model-visible declarations and descriptions.

Durable determines compaction's retained context boundary. Resource hooks can cancel compaction or supply a summary, but cannot select another cut.

[MCP settings](mcp.md) describe scoped configuration and the web-management UI.

## Lifecycle and format changes

- `.sqlite` is the session format. Existing JSONL histories and experimental sidecars are not imported or listed; data migration is a separate task.
- Client message IDs deduplicate admission. Steering and follow-up queues survive process replacement.
- `abort()` withdraws queued inputs and stops work. `dispose()` checkpoints unfinished work for recovery.
- Resources and tools are installed before recovered tasks resume.
- Failed/interrupted assistants remain visible in the transcript but are excluded from provider context by Durable.

Deployment scripts and coordinated service draining are unchanged.

## Dependencies and validation

Pi AI, agent-core, coding-agent, Durable, and Chord are pinned to 1.0.0. The coding-agent patch exposes pure prompt builders and accepts a readonly session view in `ExtensionRunner`; it does not introduce another execution engine.

Tests cover durable recovery, unsafe-tool cancellation, queues, deduplication, compaction, forks, SQLite readers, MCP reloads, nested artifacts, and detached result delivery.
