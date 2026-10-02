# Pi Durable integration

The `experiment/pi-durable` branch uses Pi Durable 1.0.0 for model generation, retries, compaction, tool scheduling, and input queues. The coding-agent SDK supplies resources, authentication, tools, and headless extension contexts; its agent loop does not run.

## Ownership

- `DurableAgentSessionController` adapts durable submissions and committed events to Batty's web protocol.
- Each session has a JSONL durable store at `<session-file>.durable`, with fsync and a lifetime writer lock.
- The native v3 session file is a presentation projection for session listings, search, pagination, metadata, and artifact readers. Durable entries carry projection identities for replay repair.
- Opening a session imports its selected native branch once. Host-appended notices and completion receipts are synchronized into durable entries.
- Batty retains cron and subagent orchestration. Each child has its own harness; children are not durable task-owned conversations.

Observers project completed entries before publishing them. Completion notifications occur after the final run in a committed frame, including admitted follow-ups. Resource reloads wait for that boundary.

## Tools and extensions

Batty retains image reading, tracked file writes, shell metadata, MCP, tool search, and Pi's built-in codemode. The tool bridge preserves SDK argument preparation, tool-call/result hooks, cancellation, progress, usage, and artifacts. SDK input hooks, commands, templates, skills, context transforms, model/thinking callbacks, and compaction hooks use the durable controller.

Tools are not replay-safe. An interrupted call produces an error result rather than repeating side effects. Codemode is one durable tool task; its nested calls use the SDK dispatch pipeline, not separate durable tasks. File, download, and site receipts are committed independently and attributed by durable tool-task identity, including late cancellation results.

The compaction bridge accepts SDK cancellation and supplied summaries. Durable determines the retained context boundary; SDK extensions cannot choose a different cut through `firstKeptEntryId`.

[MCP settings](mcp.md) retain Batty's scoped configuration, status, and OAuth UI.

## Lifecycle and breaking differences

- Steering and follow-up queues persist across process replacement. Client message IDs deduplicate durable admission.
- `abort()` stops work and withdraws queued inputs. `dispose()` checkpoints unfinished work for recovery.
- Opening a session installs resources and tools before resuming its pending tasks.
- Generated system entries are positional: an initial user input precedes its system/tool declaration.
- Durable sidecars are required to resume work. Native v3 files alone preserve conversation history, not task or inbox state.
- Model requests, retry policy, and task ownership follow Pi Durable rather than coding-agent loop/boundary hooks.

Coordinated deployment draining remains part of Batty's service lifecycle. This experiment does not change deployment scripts.

## Dependencies

Pi AI, agent-core, coding-agent, durable, and Chord are pinned to 1.0.0. Batty's SDK patches retain sampling configuration, resource access, indexed queue helpers, selected-leaf forks, read limits, and MCP web-management APIs. MCP OAuth credential access uses both server name and URL.

Tests cover recovery during generation and unsafe tools, persistent queues, deduplication, cancellation, compaction, MCP reloads, nested codemode artifacts, and detached result delivery.
