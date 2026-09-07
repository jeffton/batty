# Pi AgentHarness integration

Batty uses the pinned Pi 0.85.1 AgentHarness API. There is one execution backend.

## Ownership

- **Pi:** session JSONL, legacy-v3 normalization, immutable transcript entries, branch configuration, durable operation admission, tool intents and results, queues, retry and compaction state, deferred responses, cancellation, and recovery.
- **Batty:** workspace discovery, resource-path policy, cron scheduling and logs, detached-session presentation and result delivery, HTTP/SSE, browser state, uploads, and application metadata.

`harness-session-store.ts` owns native repository/session handles and a synchronous presentation index. It coordinates concurrent readers and writers without providing a storage implementation. Legacy sessions are imported by `JsonlSessionRepo.open`. A native application value records reminted IDs referenced by historical Batty file-change metadata. Forks use the native branch-fork API.

`harness-controller.ts` adapts the main lane to the service and SSE boundary. A Pi watch and `reduceLaneSnapshot` maintain the observable state. Prompt acceptance precedes driving. Concurrent consumers join the same drive promise; Pi owns the operation. Resumption drives the persisted operation rather than submitting another user message.

`pi-agent-session.ts` assembles the model runtime, resources, native tools, and narrow adapters. Model and thinking changes are lane commands. Skills and prompt templates use native loaders and invocation formatters. Coding-agent resource discovery provides Batty's configured paths and project instructions.

## Tools and images

Native read, write, edit, and bash run through a shared execution environment. Find, grep, PowerShell, and Batty tools have invocation adapters. Environment-file values and `PI_*` session metadata are supplied to shell calls.

Read, find, grep, and web search are replay-safe. Mutating tools use never-replay policy. Subagent replay is safe because the invocation memo durably identifies one child session: replay resumes it or reads its terminal result.

Write/edit mutation snapshots are committed inside tool-result details. Per-turn file diffs are a read-only aggregation of those snapshots, including child results. They do not require a parallel journal or transcript rewriting.

Prompt and queued image data remain in native storage. UI images use content-addressed attachment URLs. Image blocking affects provider projection, not persisted messages. Tool image resizing uses Pi's public image utility.

## Retained patch

`patches/@earendil-works__pi-agent-core@0.85.1.patch` changes the compaction cut-point selection for oversized trailing tool results. It retains their preceding assistant tool call. Native compaction tests cover the regression, compaction before the next assistant request, failed compaction, and cancellation.

## Explicit boundaries

Session creation requires an explicit model or a configured default provider/model pair. Unknown restored models produce an error rather than switching providers.

Coding-agent extensions are incompatible with the harness lifecycle and produce an initialization error. They must be expressed as native tools and hooks rather than receiving a simulated coding-agent runtime.

Legacy-v3 import preserves history and application metadata. It does not convert Batty's historical interactive-turn journal into a Pi operation.

Cron runs use the scheduler run ID as their native operation ID. Startup reconstructs scheduler waiters from persisted running logs, joins admitted Pi operations, and reads their immutable terminal results. Unadmitted runs are recorded as interrupted rather than submitted again. Recovered runs remain visible and cancellable, including deleted one-shot jobs; shutdown preserves their running logs.

Detached cron results target the persisted original daily parent. Session-delivered subagents retain their delivery request in native application metadata, so startup can resume the child or deliver its terminal result. Parent messages carry per-part delivery receipts in native storage. Replaying delivery completes partial results without duplicating persisted notices or answers, and successful `NO_REPLY` results are suppressed. These receipts describe presentation delivery, not agent execution.
