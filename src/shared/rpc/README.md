# Internal duplex RPC library

`index.ts` is the browser/Node-neutral entry point. No Batty routes, authentication,
peer identity, jobs or cursors live here.

- `RpcChannel(socket, { handle })`: symmetric named calls, JSON results/events and
  binary `ReadableStream` bodies. Incoming handlers receive an `AbortSignal` and
  optional upload stream; replies carry a value and optional body/event streams.
- `RpcClient(connect, { invalidate })`: lazy shared socket generations. Opening
  callers can cancel independently. Disconnect fails outstanding calls; a later
  call opens a fresh socket. `invalidate` applies caller-defined credential policy
  only to the generation that failed. Calls are never replayed.
- `rpcRegistry<Inputs, Outputs, Events>(operations?)`: typed value/stream registrations
  over an explicit allowlist. The same operation maps constrain callers, handler
  results and event items. Registries compose through their operation map; runtime
  validation and authorization remain domain policy.
- `RpcError` / `RpcFailure`: the same error code, message and optional structured
  details for calls and stream failures. Server domain errors share one translator.
- `rpcEvents<T>`: pull-driven object subscriptions with cancellation and cleanup.
- `splitByteStream`: sequential, manifest-delimited file parts without whole-file
  buffering. Owner and peer uploads share byte accounting and truncation/excess
  checks; their metadata validation and storage policies remain separate.

Streams start on demand and use bounded credits. Cancelling a stream cancels its
call, including remote handlers and sibling streams. Channel heartbeat detects
half-open sockets; `close()` synchronously fails volatile work and releases readers.

Batty owns operation allowlists, authorization, durable workers, event cursors and
subscription recovery. Cookie authentication/bootstrap, static resources and
ordinary browser downloads remain HTTP. Server-managed peer reconnects use
`RpcChannel` directly; they do not need `RpcClient`'s lazy opening policy.

The startup smoke script imports `channel.ts` directly using Node's type stripping,
so that check exercises the same framing implementation as the runtime.
