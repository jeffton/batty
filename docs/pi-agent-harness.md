# Pi AgentHarness integration

Batty uses the pinned Pi 0.99.1 AgentHarness API. There is one execution backend.

## Ownership

- **Pi:** session JSONL, immutable transcript entries, branch configuration, durable operation admission, tool intents and results, queues, retry and compaction state, deferred responses, and cancellation.
- **Batty:** workspace discovery, resource-path policy, cron scheduling and logs, detached-session presentation and result delivery, HTTP/SSE, browser state, uploads, and application metadata.

`harness-session-store.ts` owns native repository/session handles and a synchronous presentation index. It coordinates concurrent readers and writers without providing a storage implementation. Forks use the native branch-fork API.

`harness-controller.ts` adapts the main lane to the service and SSE boundary. A Pi watch and `reduceLaneSnapshot` maintain the observable state. Prompt acceptance precedes driving. Concurrent consumers join the same drive promise; Pi owns the operation while the server is running.

`pi-agent-session.ts` assembles the model runtime, resources, native tools, and narrow adapters. Model and thinking changes are lane commands. Skills and prompt templates use native loaders and invocation formatters. Coding-agent resource discovery provides Batty's configured paths and project instructions.

## Deployment drain

The CLI uses a local socket or Windows named pipe to stop new turn admissions and pause cron scheduling. Deployment waits without a timeout for admitted work, descendants, and result delivery to settle. Idle sessions and SSE connections do not count as work.

Track each asynchronous turn from admission through completion, including preparation and delivery. Child work belonging to an admitted turn can run during draining. `TurnDrain` tracks interactive and subagent work; `CronService.activeTurns` tracks scheduled work and delivery retries.

Unexpected interruption does not trigger recovery. Opening a session aborts orphaned Pi operations before accepting another prompt; transcript history remains available.

## Tools and images

Native read, write, edit, and bash run through a shared execution environment. Find, grep, PowerShell, and Batty tools have invocation adapters. Environment-file values and `PI_*` session metadata are supplied to shell calls.

Read, find, grep, and web search are replay-safe. Mutating and stateful browser tools use never-replay policy. Browser pages use isolated contexts scoped to the live Batty session and are closed when that session is disposed. Invocation memos durably identify child sessions and terminal results.

Write/edit mutation snapshots are committed inside tool-result details. Per-turn file diffs are a read-only aggregation of those snapshots, including child results. They do not require a parallel journal or transcript rewriting.

Prompt and queued image data remain in native storage. UI images use content-addressed attachment URLs. Image blocking affects provider projection, not persisted messages. Tool image resizing uses Pi's public image utility.

## Codemode

The `codemode` tool uses `@earendil-works/pi-codemode` for source parsing, declarations, and QuickJS execution. Scripts batch or chain active tools through `tools.<name>(args)` and return selected output with `text()`, `image()`, or `return`. Direct tools remain enabled. The optional `// @options:` line controls the deadline and output budget; oversized text is saved to a temporary file.

Nested calls use the harness's argument validation, before/after hooks, cancellation, and scoped invocation memos. Their artifacts and call summaries are stored in the parent result, not separate model messages. Codemode is never replayed. Successful `store()` writes persist in result details and `load()` reconstructs them from the current branch, including after reopen and fork.

Server builds include `codemode-worker.mjs` and `quickjs.wasm`.

## Retained patch

`patches/@earendil-works__pi-agent-core@0.99.1.patch` retains the assistant tool call when compaction encounters oversized trailing results, removes the read byte cap when an explicit line limit is supplied, and exposes `invocation.executeTool()` for nested calls through the native tool pipeline. Nested calls share the parent operation and use distinct invocation identities; they do not create independent transcript entries.

## Explicit boundaries

Session creation requires an explicit model or a configured default provider/model pair. Unknown restored models produce an error rather than switching providers.

Coding-agent extensions are incompatible with the harness lifecycle and produce an initialization error. They must be expressed as native tools and hooks rather than receiving a simulated coding-agent runtime.

Cron runs use the scheduler run ID as their native operation ID. During a coordinated deployment, scheduling pauses while admitted work finishes. At startup, persisted running logs are recorded as interrupted rather than resumed or submitted again.

Detached cron results target the persisted original daily parent. Parent messages carry per-part delivery receipts in native storage. A coordinated deployment lets active deliveries finish; startup does not reattach unfinished deliveries. These receipts describe presentation delivery, not agent execution.
