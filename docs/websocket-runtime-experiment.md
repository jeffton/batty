# Native WebSocket runtime experiment

Branch: `feature/websocket-runtime`. Main comparison baseline: `06eb679`. Superseded HTTP-tunnel attempt: `540d7fa`.

## Architecture

Browser app traffic and paired-node runtime traffic share `RpcChannel`: named operations, object events and raw binary streams. Owner and node registries call domain services directly. Native paths do not dispatch HTTP URLs/methods, invoke loopback HTTP or serialize SSE/NDJSON. The obsolete tunnel and client adapters are removed.

HTTP remains for bootstrap, authentication, pairing, static assets, sites, navigation and natural resource downloads. Cloud-browser video retains its specialized WebSocket. HTTP also serves CLI cron/remotes, health/version and service stop. Superseded owner REST, node HTTP/SSE, browser-control, MCP and memory controllers are removed. Tests exercise native operations or shared domain services rather than preserving obsolete routes.

The reusable `src/shared/rpc/` library separates channel framing from lazy client connection lifecycle. Owner/session registries share a small typed registration helper; validation and authorization remain explicit domain policy. The shared transport handles correlated calls, cancellation, heartbeat and binary flow control: 64 KiB frames with 16 credits, not a file-size limit. Object events preserve session cursors without SSE framing. Disconnect fails volatile calls without replay. Durable jobs, mirrors, request IDs and recovery cursors remain above the transport.

## Authorization

Shared framing does not mean shared permissions. Browser upgrades require same-origin owner authentication; operations recheck the cookie. Node connections reject browser origins and bind bearer grants to installation identity. Control/file/unpair operations wait for verified identity and recheck grants. File storage roots remain server-owned. Removal closes streams and revokes access.

## Complexity

Counts include new source files, exclude docs/scripts/dependency metadata, and classify tests/fixtures separately:

| Comparison       | Production                           | Tests/fixtures                         |
| ---------------- | ------------------------------------ | -------------------------------------- |
| Main `06eb679`   | +2,896 / −2,612 = **+284**, 47 files | +3,663 / −2,438 = **+1,225**, 53 files |
| Tunnel `540d7fa` | +2,738 / −2,869 = **−131**, 48 files | +3,252 / −3,324 = **−72**, 55 files    |
| Native `728eeaf` | +651 / −1,747 = **−1,096**, 29 files | +1,256 / −1,808 = **−552**, 38 files   |

The native operation model is cleaner than HTTP/SSE tunneled over WebSocket: business operations and typed inputs replace URL/status/header plumbing. Production code is slightly larger than main and slightly smaller than the tunnel attempt. Extracting shared mechanics and removing duplicate controllers cuts 1,096 net production lines from the first native rewrite. Renaming files contributes to the gross additions/removals; net counts include every source file. We also own multiplexing, flow control and stream lifetime that HTTP supplied previously.

## Dependency

Server `ws` is pinned at 8.22.1; `@fastify/websocket` and `@types/ws` already existed. Version 8.22.2 did not satisfy the repository release-age policy when selected. [8.22.1 release notes](https://github.com/websockets/ws/releases/tag/8.22.1) describe an IPC URL fix and native Node masking/unmasking support. Browser clients use native WebSocket. The native rewrite adds no further dependency.

## Validation

- Final isolated Arch full suite: 216 files, 1,111 passed, two existing skips. The successful runner printed `ECONNREFUSED localhost:3000`; this diagnostic remains unresolved.
- `pnpm check` passed with ten existing unused-variable warnings.
- Build, strict offline checks at 390/1100 pixels, packaged startup at `/` and `/batty`, and both deployment regression scripts passed.
- Real WebSocket tests cover peer identity admission, malicious early controls, bidirectional files/jobs, corrupt/interrupted transfers, cancellation, reconnect, restart and revocation. Client tests cover idle sessions, stale authentication generations and upload cancellation.
- Independent Sol reviews approved transport, owner and peer authorization, client lifecycle and native architecture.

## Boundaries

Both peers must run this experimental implementation. Reverse proxies must support WebSocket upgrades; there is no transport fallback. Interrupted volatile operations are not retried. Unpair during an outage can leave an inert stale entry on the unreachable peer.

Actual IIS and the work VPN are untested. No merge, deployment, production data change or work-machine change is part of this experiment.
