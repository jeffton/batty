# Native RPC implementation contract

Experimental branch only. Replace the HTTP/SSE tunnel, not the domain model.

Reusable mechanics live in `src/shared/rpc/`: `channel.ts` owns framing/streams and `client.ts` owns lazy, generation-safe connection lifecycle. The public entry point is `index.ts`:

```ts
export type RpcContext = { signal: AbortSignal; body?: ReadableStream<Uint8Array> };
export type RpcReply<T = unknown, Event = unknown> = {
  value: T;
  body?: ReadableStream<Uint8Array>;
  events?: ReadableStream<Event>;
};
export type RpcHandler = (
  operation: string,
  input: unknown,
  context: RpcContext,
) => Promise<RpcReply>;
export class RpcError extends Error {
  code: string;
}
export class RpcChannel {
  constructor(socket: ChannelSocket, options?: { handle?: RpcHandler });
  call<T = unknown, Event = unknown>(
    operation: string,
    input: unknown,
    options?: { signal?: AbortSignal; body?: ReadableStream<Uint8Array> },
  ): Promise<RpcReply<T, Event>>;
  readonly closed: Promise<void>;
  close(error?: Error): void;
}
```

`ChannelSocket` abstracts the browser and Node WebSocket interfaces. JSON calls/results and event items are protocol frames; bytes use binary frames with bounded sliding credits. No Request, Response, URL, HTTP method/status/headers or SSE/NDJSON framing. Input/output stream channels are call-scoped and cancel/disconnect with the call. Core owns heartbeat and flow control; durable jobs/cursors remain outside it. Error codes: UNAUTHORIZED, FORBIDDEN, NOT_FOUND, BAD_INPUT, OFFLINE, INTERNAL; domain-specific codes permitted.

Browser singleton in `client/lib/rpc.ts`: `rpcCall(operation,input,options?)`, `closeRpcTransport()`. Shared `OwnerInputs/OwnerOutputs/OwnerEvents` and `NodeInputs/NodeOutputs/NodeEvents` maps determine input, result and event types at both caller and registration boundaries. Callers do not supply result types; low-level channel generics stay at the transport boundary. Browser operation names use `session.get`, `session.messages`, `session.resources`, `session.subagents`, `main.submit`, `main.stop`, `main.queue.remove`, `workspace.list`, `workspace.git`, `workspace.files`, `workspace.file`, `workspace.search`; other names selected by browser operation owner and communicated to client owner. No route mapper on the native path.

Owner handler factory in `server/owner-rpc.ts` registers explicit named operations with direct domain functions, not Fastify injection or generic callback emulation. HTTP endpoints remain only for actual consumers: bootstrap/auth, resources, CLI cron/remotes, pairing, sites/functions, health/version and service stop. Superseded owner REST, node HTTP/SSE and browser-control routes are removed; tests exercise native operations or domain services. Native operations must not delegate through HTTP. Register factory from main with runtime/services it needs. Session producers expose objects through an event sink, not ServerResponse/SSE.

Peer handler factory in `server/node-rpc.ts`: `createNodeRpcHandler(remotes,connection,services)` (exact services negotiated by peer owner). Operations: `node.identity`, `node.discovery`, `node.command`, `node.assignment`, `node.file`, `node.unpair`, subscriptions `node.catalog.watch`, `node.session.watch`. Bound peer credentials verified per operation outside payload. Peer owner updates reverse-connections and remote-workers; browser owner updates owner socket/main registration.

Files: metadata in operation input/value, byte streams in body. Shared `splitByteStream` enforces manifest lengths for owner and peer uploads; metadata validation, storage and hashing remain domain-specific. Shared `rpcEvents<T>` owns pull-driven subscription lifecycle. Both operation boundaries use one domain-error translator into `RpcError`; transport frames share `RpcFailure` for calls and stream failures. No multipart on native path. Browser natural HTTP resource serving/bootstrap/auth remains HTTP. No deploy or production changes.
