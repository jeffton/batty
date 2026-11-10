# Client API

## Browser application

The authenticated browser API is a typed RPC channel on the same-origin WebSocket endpoint `/api/socket`. Its operation names, input/output contracts and event types are defined in `shared/owner-api.ts`. Calls carry operation names and domain values; streaming operations deliver typed event streams and optional binary bodies. The browser connection, reconnect and event delivery live in `client/lib/rpc.ts` and `client/lib/session-connection.ts`.

Main and worker transcripts use `session.get`, `session.messages` and the `session.watch` event stream. `session.watch` sends an initial snapshot, incremental session events and main-app status events, including build IDs, provider-auth attempts, MCP-auth attempts and provider-usage updates. Reconnects resume from the current session cursor; command operations are never replayed. `main.submit`, `main.stop` and `main.queue.remove` mutate the main session.

Workspace, model, memory, cron, provider, settings, environment, MCP, push, site, browser and auth operations use the same typed owner channel. See `shared/owner-api.ts` for the complete contract. Ordinary HTTP remains for bootstrap/authentication, static assets, public health/version checks, site resources and other natural HTTP resources; it is not the transcript event API.

Cloud-browser viewing uses a dedicated authenticated WebSocket at `/api/cloud-browser/:browserId/socket` for state and binary video frames. Browser controls use the typed owner RPC operations. Details of the frame protocol and lifecycle are in `shared/cloud-browser.ts` and `docs/runtime.md`.

## Paired Batty instances

A paired node uses `/api/node/socket`, authenticated with its scoped bearer grant and bound to its installation identity. Its operation contracts are in `shared/node-api.ts`; shared call/event/byte-stream framing is in `shared/rpc/`. Owner and node sockets share transport code, not operation registries or permissions. Pairing and operational details are in `docs/remote-instances.md`.

## Provider and MCP transports

Model-provider streaming is handled by the installed Pi AI adapters; it is separate from Batty's browser and peer transports. The Codex adapter uses WebSocket automatically and can fall back to SSE with its HTTP provider API. MCP connections use stdio or Streamable HTTP.
