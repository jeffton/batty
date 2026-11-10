# Native WebSocket runtime experiment

Branch: `feature/websocket-runtime`. Main comparison baseline: `06eb679`. Superseded HTTP-tunnel attempt: `540d7fa`.

## Architecture

Browser app traffic and paired-node runtime traffic share `RpcChannel`: named operations, object events and raw binary streams. Owner and node registries call domain services directly. Native paths do not dispatch HTTP URLs/methods, invoke loopback HTTP or serialize SSE/NDJSON. The obsolete tunnel and client adapters are removed.

HTTP remains for bootstrap, authentication, pairing, static assets, sites, navigation and natural resource downloads. Cloud-browser video retains its specialized WebSocket. Thin HTTP controllers and native handlers share domain helpers; small browser/MCP boundary adapters remain where their HTTP-facing APIs are independently needed.

The shared transport handles correlated calls, cancellation, heartbeat and binary flow control: 64 KiB frames with 16 credits, not a file-size limit. Object events preserve session cursors without SSE framing. Disconnect fails volatile calls without replay. Durable jobs, mirrors, request IDs and recovery cursors remain above the transport.

## Authorization

Shared framing does not mean shared permissions. Browser upgrades require same-origin owner authentication; operations recheck the cookie. Node connections reject browser origins and bind bearer grants to installation identity. Control/file/unpair operations wait for verified identity and recheck grants. File storage roots remain server-owned. Removal closes streams and revokes access.

## Complexity

Counts include new source files, exclude docs/scripts/dependency metadata, and classify tests/fixtures separately:

| Comparison       | Production                             | Tests/fixtures                         |
| ---------------- | -------------------------------------- | -------------------------------------- |
| Main `06eb679`   | +3,098 / −1,742 = **+1,356**, 38 files | +3,084 / −1,283 = **+1,801**, 39 files |
| Tunnel `540d7fa` | +2,888 / −1,930 = **+958**, 39 files   | +2,656 / −2,169 = **+487**, 40 files   |

The native operation model is cleaner than HTTP/SSE tunneled over WebSocket: business operations and typed inputs replace URL/status/header plumbing. It is not smaller. Explicit operation registries, shared domain extraction, binary admission and browser fixture migration cost more code than reusing HTTP handlers through a tunnel. We also own multiplexing, flow control and stream lifetime that HTTP supplied previously.

## Dependency

Server `ws` is pinned at 8.22.1; `@fastify/websocket` and `@types/ws` already existed. Version 8.22.2 did not satisfy the repository release-age policy when selected. [8.22.1 release notes](https://github.com/websockets/ws/releases/tag/8.22.1) describe an IPC URL fix and native Node masking/unmasking support. Browser clients use native WebSocket. The native rewrite adds no further dependency.

## Validation

- Final isolated Arch full suite: 216 files, 1,115 passed, two existing skips. The successful runner printed `ECONNREFUSED localhost:3000`; this diagnostic remains unresolved.
- `pnpm check` passed with ten existing unused-variable warnings.
- Build, strict offline checks at 390/1100 pixels, packaged startup at `/` and `/batty`, and both deployment regression scripts passed.
- Real WebSocket tests cover peer identity admission, malicious early controls, bidirectional files/jobs, corrupt/interrupted transfers, cancellation, reconnect, restart and revocation. Client tests cover idle sessions, stale authentication generations and upload cancellation.
- Independent Sol reviews approved transport, owner and peer authorization, client lifecycle and native architecture.

## Boundaries

Both peers must run this experimental implementation. Reverse proxies must support WebSocket upgrades; there is no transport fallback. Interrupted volatile operations are not retried. Unpair during an outage can leave an inert stale entry on the unreachable peer.

Actual IIS and the work VPN are untested. No merge, deployment, production data change or work-machine change is part of this experiment.
