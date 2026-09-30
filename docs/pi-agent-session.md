# Pi AgentSession integration

Batty uses Pi 0.99.1's coding-agent SDK. Commit `566c1d7` is the AgentHarness comparison baseline.

## Ownership

- `createAgentSession()` owns prompting, tools, extensions, model requests, retries, compaction, steering, and follow-up queues.
- Pi `SessionManager` owns native v3 session files and branch history.
- `AgentSessionController` adapts admission, asynchronous web subscribers, queue identity, background-result delivery, and shutdown. It has no Harness operations, lanes, snapshots, or invocation memos.
- `SessionStore` adapts paths, branch selection, summary notifications, and Batty's configured defaults.
- Batty owns cron/subagent orchestration, completion receipts, web projections, image sidecars, and artifact attribution.

Pi's public subscribers run before `message_end` persistence. Batty defers subscriber delivery one microtask so transcript projections see durable entries, and joins asynchronous subscribers at product boundaries. Completion notifications use `agent_settled`, not `agent_end`, because Pi may retry, compact, or continue after an agent loop ends.

Direct tools and codemode remain enabled. Codemode is Pi's built-in extension, including its sandbox, declarations, dynamic catalog, output truncation, and branch-local store. Nested calls use Pi's tool hooks and call IDs. Batty attaches nested file changes, downloads, and sites to the outer result. Native shell calls inside codemode return structured results, including `output` and `exit_code`.

Configured coding-agent extensions load through `DefaultResourceLoader` with Batty's resource paths. They receive a headless SDK context; Batty does not render terminal dialogs or widgets. Native MCP and tool-search extensions share this lifecycle. Batty's [MCP settings](mcp.md) manage scoped configuration, status, and OAuth through a dedicated web UI bridge.

## Async subagent handoff

`subagent await` with `sessionId` yields the parent turn at the completed tool batch. It does not start child work or abort tool execution. If the child has finished and its reply has been admitted, the action returns without yielding. Pending child turns and result admission count as active work.

The controller uses Pi's `agent.finishTurn` boundary. Admitted input is consumed before yielding; input arriving after the end decision is admitted after idle. Async replies either steer the active parent or start a fresh turn, including replies that arrive during the handoff.

`resume` requires a finished child and rejects active operations. Use `steer` to add instructions to an active turn or `queue` to schedule another task after its reply.

## Storage and execution differences

| Concern                  | AgentHarness baseline                         | AgentSession evaluation                                  |
| ------------------------ | --------------------------------------------- | -------------------------------------------------------- |
| Native session format    | v4                                            | v3                                                       |
| Execution model          | Explicit durable operations and lanes         | Conversation API with process-local runs                 |
| Queued user input        | Durable lane state                            | In-memory SDK queues                                     |
| Codemode integration     | Standalone runtime plus nested-dispatch patch | Built-in SDK extension and native nested dispatch        |
| Coding-agent extensions  | Rejected                                      | Headless SDK extensions                                  |
| Image storage            | Harness image references                      | Native inline images plus Batty UI sidecars              |
| File-change attribution  | Tracked Harness execution environment         | Injectable SDK write/edit operations and result hooks    |
| Cron/subagent completion | Harness operation state                       | Batty custom-entry receipts and native branch boundaries |
| Crash continuation       | Not resumed by Batty                          | Not resumed by Batty                                     |

Session storage requires native Pi v3 files and canonical Batty metadata. Tool preferences use `batty-session-tools`; cron and subagent completion records contain explicit, exclusive-start/inclusive-end entry boundaries.

Coordinated deployment draining remains required. Queued prompts do not survive process replacement. Completed cron runs and detached children have persisted receipts; interrupted executions are rejected rather than replayed. Subagent tool calls allocate a fresh child identity per invocation.

Appended background transcripts refresh SDK context after persistence. Custom notices use native `custom_message` entries with `details`; ordinary Batty metadata uses native `custom` entries with `data`.

## SDK patches

Batty retains the Pi AI sampling patch and applies these SDK adaptations:

- Agent-core: inspect queued messages and remove a selected message without disturbing duplicate text, images, or unrelated custom steering.
- AgentSession: preserve client/queue IDs on user messages; expose indexed user queues, targeted removal, and cancellable prompt preflight.
- SessionManager: persist initial setup immediately and fork a selected leaf, including an explicitly empty branch.
- Read: explicit line limits remove the byte cap.
- Codemode: cancel and join admitted host calls before returning, including failure, deadline, and sandbox close.
- MCP: expose native configuration/credential helpers, explicit config paths, and connection-status snapshots for Batty's web manager.
- Extension UI: expose Pi's headless UI defaults for the MCP OAuth input/notification bridge.

The upstream compaction implementation handles trailing tool results without a Batty patch. Worker and WASM assets come from installed Pi packages; Batty does not ship a separate codemode worker.

## Comparison

AgentSession removes Batty's Harness controller/storage implementation, custom codemode orchestration, nested-dispatch patch, and image-reference plumbing. Pi coding-agent features use their native lifecycle instead of being ported onto Harness.

The trade-off is process-local execution/queues, a breaking storage change, and additional SDK adaptation for Batty's web-facing queue identity and delivery guarantees. It reduces feature-integration work; it does not eliminate SDK maintenance or Batty's orchestration layer.
