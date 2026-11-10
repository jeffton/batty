# Remote instances

A remote Batty runs ordinary workers with its own workspaces, tools, instructions, models and credentials. The initiating installation sends commands and keeps a local read mirror; it does not provide the remote's model credentials or replace its agent runtime.

## Pairing

1. On the Batty you can reach, open **Settings → Remote** and select **Generate token**.
2. On the other Batty, enter its **URL** and the token, then select **Add**.

This single pairing permits subagent operations in both directions. The token is a single-use invitation, displayed only until the Remote tab closes; copy it with **Copy token**. An unused invitation can be cancelled. Tokens are never owner-login credentials.

The instance selecting Add opens an outbound authenticated WebSocket to the other Batty. If only Mac can reach Windows over the work VPN, generate the token on Windows and select Add on Mac. Windows sends requests back over that same duplex connection; Windows does not need to dial Mac. The initiating machine does not advertise or need a reachable URL. Installation IDs, names and scoped credentials are exchanged and stored automatically. Connection names use the hostname and a short stable installation ID.

The peer list shows online/offline status. **Refresh** updates it without background status polling. **Remove** immediately revokes local access and closes streams; an online peer is notified to remove its reciprocal pairing. Offline removal prevents further local access. A disconnected peer cannot use its retained credential for agent operations without a live authenticated control channel; reconnecting to a removed pairing is denied and removes the stale local pairing. Pairing again requires a fresh invitation.

The invitation can retry only its exact persisted claim after a lost response. A different claimant cannot reuse it or replace a known installation. Neither command submissions nor agent execution are replayed during reconnection. Each node retains its own workspaces, models, credentials and worker state.

### Connection requirements

URLs require HTTPS with trusted certificates. HTTP is accepted only on loopback for development. Existing URL base paths are supported. A WebSocket upgrade must pass through the HTTPS proxy; no public relay, SSH tunnel or reachable inbound URL on the initiating machine is required.

IIS or another HTTPS proxy must forward WebSocket upgrades beneath Batty's base path and permit long-lived connections. Heartbeats and reconnect backoff detect network loss and standby; they do not poll agent status. The actual work VPN and IIS configuration require machine testing; local integration tests do not verify them.

### CLI

The running local service exposes the same owner-authenticated flow:

```sh
batty2 remote token generate
batty2 remote token list
batty2 remote token revoke --id TOKEN_ID
batty2 remote connection add --url https://work.example.com/batty/ --token-stdin < /private/path/pairing-token
batty2 remote connection list
batty2 remote connection remove --id PEER_ID
```

Use `--root PATH` before `remote` to select another installation root. `--token TOKEN` is available but exposes the invitation in shell history and process arguments. The CLI uses the local owner credential only against its local loopback service.

### Breaking remote setup change

Manually configured directional remote grants and connections require fresh pairing. Their saved data is preserved, but unpaired grants cannot authorize node operations and unpaired connections do not start channels. Remove those entries and pair using URL and one generated token. Worker history, mirrors, sessions and other integrations are preserved. Legacy CLI grant commands and user-supplied connection IDs/names are not supported.

## Workers

The subagent tool's `workspaces` action discovers configured nodes, their workspaces (including the remote assistant workspace), available models and `defaultModel`. Model entries include provider-qualified IDs, supported thinking levels and image support from the receiving installation's model catalog. Pass an ID as `model` when starting a worker; omitting it uses the receiving main agent's model. Set `nodeId` on discovery to query one connection. Set `nodeId` to the connection ID and `workspaceId` to the receiving installation's workspace ID when starting a remote worker. Omit `nodeId` for local execution.

Remote session IDs have the form `remote:NODE_ID:SESSION_ID`, for example `remote:work:123`. Use that ID with the ordinary lifecycle actions (`inspect`, `await`, `steer`, `queue`, `resume`, `stop`). Workers are visible on both installations; the initiating installation can also discover and control existing workers on the receiver.

The running Tasks menu shows remote workers assigned by the conversation being viewed, using locally saved node/session/parent assignments. Discovery alone does not add Tasks: a worker started independently on a connected peer is not a task of this installation. Main, project, nested and cron conversations each retain their own assignment scope, including after a restart.

Commands carry durable request IDs. Transport reconnection never replays commands; an interrupted submission reports an error rather than silently starting replacement work. Reports stay bound to their assignment's initiating conversation, including later queue/resume assignments. Resumable WebSocket event streams mirror status and conversation output locally. Historical workers are discovered without downloading their transcripts; active or assigned sessions are mirrored, and streams retire only after their terminal history cursor has arrived. Reports and completion results return to the initiating conversation for the corresponding assignment. The mirror persists under `.batty/remote-mirrors`, so received history remains available while the remote is offline; execution and live commands still require connectivity. Offline availability is separate from the last-known worker status: completed results remain completed, and unavailable active workers show their last-known lifecycle without a live spinner. Await uses catalog events and reconnect snapshots rather than periodic status polling; it survives temporary disconnection and ends with an error if the configured connection is removed or access is revoked. File attachments are copied into local attachment storage. Hosted sites and live cloud-browser sessions are not relayed.

### Files sent to workers

`subagent` accepts `files: [{ path: "drawing.png" }, { ref: "file:…" }]` on `run`, `queue`, `resume` and `steer`, locally and remotely. Paths resolve against the caller's working directory. File refs must already exist in the caller's conversation; site and browser refs are not file inputs. A prompt is still required.

Each tool call freezes the selected bytes in attachment storage before submission. Queued inputs and retries use those snapshots, not mutable workspace originals. The worker receives its own local paths and native image blocks. Model-visible images use the same conversion and resizing as `read`, while attachments retain their original bytes. Images that cannot be prepared are rejected before assignment admission. Inputs appear as attachments in its transcript; remote mirrors import those attachments through the existing authenticated sent-file endpoint. Input files are retained with attachment history, not deleted when the assignment finishes.

Remote input uses multipart on the existing node command endpoint: a `command` metadata field followed by ordered binary `file-0`, `file-1`, … parts. The manifest carries names, MIME types, byte lengths and SHA-256 hashes, never sender filesystem paths. The receiver streams and validates every file before admitting the durable command. The node bearer grant authenticates the entire request; owner cookies are not transferred. Commands without files retain the JSON transport. Both installations must support multipart worker commands to send files; there is no legacy transport fallback.

Limits are 32 files and 100 MiB total per message. Failed transfers do not submit partial assignments. Retries preserve request identity and reject changed files or commands. Queue/resume/steer retain their existing lifecycle rules, including errors when the worker changes state during transfer. Files are data: they are not unpacked, executed or written over workspace files. Remote sites remain links; site and live-browser attachments are not federated.

Attachment import failures do not prevent result delivery or terminal status. Unavailable files are omitted and reported by name and error. Permanent HTTP 4xx errors (except 408 and 429) are cached for the process lifetime; transient errors can be retried on later projections. Sent-file URLs use the same URL-safe segments as attachment storage, avoiding encoded slashes through proxies.

Each paired installation exports only its own native workers, not its imported mirrors. Workspace discovery does not recursively follow other peer connections.

## Credentials and URLs

`<battyDir>/.batty/remote-access.json` stores the installation UUID, invitation hashes, paired node grants, outgoing scoped credentials and pending pairing claims. Outgoing tokens and pending claim credentials are stored in plaintext for transport use. The file is private (`0600`), replaced atomically, and mutations are serialized. Protect it like other installation credentials; do not include it in public artifacts or logs. Public grant and connection listings omit tokens and hashes.

Connection URLs require HTTPS. HTTP is accepted only for `localhost`, `127.0.0.1` and `::1` development endpoints. Base paths are supported and normalized with a trailing slash; URL credentials, queries and fragments are rejected. Connection IDs contain letters, digits, underscores or hyphens and begin with a letter or digit.
