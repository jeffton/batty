# Remote instances

A remote Batty runs ordinary workers with its own workspaces, tools, instructions, models and credentials. The initiating installation sends commands and keeps a local read mirror; it does not provide the remote's model credentials or replace its agent runtime.

## Provisioning

### Settings

Open **Settings → Remote** on each installation.

1. On the receiving Batty, enter a name under **Incoming access** and select **Create token**.
2. Copy the token. It is displayed only until you leave the Remote tab or close Settings.
3. On the initiating Batty, fill in **Connections** with a name, the receiving Batty's URL and the token. Select **Add connection**. Settings generates the internal connection ID; the CLI accepts an explicit ID.

The connection is saved only after authentication with the receiver succeeds. Saved connection lists never display tokens. Incoming access lists show grant names and IDs, not tokens; create a new grant if a token is lost. Removal and revocation ask for confirmation. **Remove connection** disconnects and removes the locally saved credential; **Revoke access** invalidates the incoming token on the receiver. These are separate operations.

Settings and the CLI use the same owner-authenticated provisioning API and credential store.

### CLI

Run commands on the installation being configured. Use `--root PATH` before `remote` when its installation root differs from `/var/lib/batty2`. The local service must be running: the CLI uses its authenticated loopback API, so grants and connections take effect without a restart.

On the receiving installation:

```sh
batty2 remote grant add --label "Home installation"
batty2 remote grant list
```

`grant add` prints JSON containing the grant ID and a random 256-bit bearer token. This is the token's only display; keep the output private. Transfer the token privately to the initiating installation. The receiver stores only its SHA-256 hash.

On the initiating installation:

```sh
batty2 remote connection add --id work --label "Work" \
  --url https://work.example.com/batty/ --token-stdin < /private/path/node-token
batty2 remote connection list
```

The input file contains only the token. `--token TOKEN` is also supported, but exposes the credential in process arguments and potentially shell history. Connection creation authenticates against the receiver's identity endpoint and records its instance UUID and grant ID. An ID with saved history cannot be reused for a different installation. Self-connections and a second connection to an already connected installation are rejected. A failed handshake does not save a connection.

Withdraw access on the receiving installation:

```sh
batty2 remote grant revoke --id GRANT_ID
```

Remove saved credentials and disconnect on the initiating installation:

```sh
batty2 remote connection remove --id work
```

Removing a connection does not revoke the receiving grant. Use a separate grant per connection. Node tokens authorize remote operations, not owner login; never transfer an installation's `authSecret`. The CLI uses the local owner credential only to contact its own service.

## Workers

The subagent tool's `workspaces` action discovers configured nodes, their workspaces (including the remote assistant workspace), available models and `defaultModel`. Model entries include provider-qualified IDs, supported thinking levels and image support from the receiving installation's model catalog. Pass an ID as `model` when starting a worker; omitting it uses the receiving main agent's model. Set `nodeId` on discovery to query one connection. Set `nodeId` to the connection ID and `workspaceId` to the receiving installation's workspace ID when starting a remote worker. Omit `nodeId` for local execution.

Remote session IDs have the form `remote:NODE_ID:SESSION_ID`, for example `remote:work:123`. Use that ID with the ordinary lifecycle actions (`inspect`, `await`, `steer`, `queue`, `resume`, `stop`). Workers are visible on both installations; the initiating installation can also discover and control existing workers on the receiver.

Commands carry durable request IDs, so reconnect/replay does not start duplicate work. Reports stay bound to their assignment's initiating conversation, including later queue/resume assignments. Resumable SSE streams mirror status and conversation output locally. Historical workers are discovered without downloading their transcripts; active or assigned sessions are mirrored, and streams retire only after their terminal history cursor has arrived. Reports and completion results return to the initiating conversation for the corresponding assignment. The mirror persists under `.batty/remote-mirrors`, so received history remains available while the remote is offline; execution and live commands still require connectivity. File attachments are copied into local attachment storage. Hosted sites and live cloud-browser sessions are not relayed.

Connections are directional. Bidirectional connections are supported: each installation exports only its own native workers, not its imported mirrors, and workspace discovery does not recursively follow its outgoing connections.

## Credentials and URLs

`<battyDir>/.batty/remote-access.json` stores the installation UUID, incoming grant IDs/labels/hashes and outgoing connections. Outgoing tokens are stored in plaintext for transport use. The file is private (`0600`), replaced atomically, and mutations are serialized. Protect it like other installation credentials; do not include it in public artifacts or logs. Public grant and connection listings omit tokens and hashes.

Connection URLs require HTTPS. HTTP is accepted only for `localhost`, `127.0.0.1` and `::1` development endpoints. Base paths are supported and normalized with a trailing slash; URL credentials, queries and fragments are rejected. Connection IDs contain letters, digits, underscores or hyphens and begin with a letter or digit.
