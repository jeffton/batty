# WebSocket runtime experiment

Branch: `feature/websocket-runtime`. Comparison baseline: `06eb679`.

## Scope

Browser app requests and paired-node calls share `SocketChannel`, a duplex Request/Response protocol over WebSocket. A single peer connection carries calls in either direction; only its dialer needs a reachable URL. Browser requests share one authenticated socket. Session event streams retain their SSE framing inside response bodies, so existing session cursors and recovery logic remain authoritative.

HTTP serves bootstrap, login/cookie ceremonies, public version checks, pairing, static assets, sites, normal navigation and resource downloads. Cloud-browser video keeps its specialized WebSocket. This is an app-transport experiment, not an attempt to replace the web platform.

## Shared machinery

- UUID-correlated calls, response status/headers and binary request/response bodies.
- Pull-driven 64 KiB frames with a 16-frame credit window: at most 1 MiB of queued body data per direction/exchange. The window pipelines transfer across network latency; it is not a file-size limit. Producers retain their current source chunk.
- Per-call cancellation and synchronous cleanup on disconnect. A 15-second heartbeat detects inactivity after 45 seconds.
- No command replay or polling. Volatile calls fail on disconnect; reconnect opens a fresh transport. Durable jobs, remote mirrors, request IDs and event cursors stay above it.

Browser and node channels share framing, not permissions. Browser upgrade requires owner authentication and same origin; handlers revalidate the session cookie. Node upgrade rejects browser origins and binds its bearer grant to the paired installation. Each node operation rechecks the bound grant. Unpair admission performs authenticated durable removal before closing its own connection.

A fixed loopback HTTP adapter reuses existing validated route handlers. It accepts neither caller-controlled hosts nor forwarding credentials. This avoids rewriting business APIs, but retains an internal HTTP hop and means SSE parsing and HTTP-shaped Request/Response semantics remain.

## Complexity assessment

Against `06eb679`, production source changes by +892/−494 lines: **+398 net across 19 files**, including new files. Tests and fixtures change by +1,626/−312: **+1,314 net across 31 files**. The offline verification script adds 25 net lines; dependency metadata and this document are excluded from those source counts.

The transport vocabulary is more uniform: browser and peer calls use one multiplexed stream implementation, replacing the peer control-SSE/GET-body/POST-response choreography. The trade is ownership of framing, flow control, cancellation, heartbeat and stream lifecycle code that HTTP previously provided. This branch is not a business-API simplification or a line-count reduction.

Browser tests require a real fixture WebSocket bridge; ordinary HTTP interceptors cannot observe socket-carried operations. That migration adds test infrastructure as well as production transport code.

## Dependency

`ws` is a direct server dependency at 8.22.1; `@fastify/websocket` and `@types/ws` already existed. The newer 8.22.2 did not satisfy the repository release-age policy when selected. [8.22.1 release notes](https://github.com/websockets/ws/releases/tag/8.22.1) describe an IPC URL fix and native Node masking/unmasking support; no application migration was required. Browser clients use their native WebSocket implementation.

## Validation

- Serial isolated full suite: 214 files, 1,098 tests passed, two existing skips. An `ECONNREFUSED localhost:3000` diagnostic was printed; the runner exited successfully with no failed tests or reported unhandled errors.
- Real paired-node integration: 23/23, including root/nested proxies, jobs/files both ways, reconnect, restart and revocation.
- `pnpm check`, build, both deployment regression scripts, startup checks at `/` and `/batty`, and offline browser checks at 390/1100 pixels passed.
- Independent implementation/security review and browser-fixture review approved. Initial fixture failures were corrected before the passing full-suite run.

## Operational boundaries

Both peers must run the experimental implementation. Established peer runtime traffic requires WebSocket upgrades through the reverse proxy; there is no HTTP/SSE transport fallback. Pairing remains HTTPS. Interrupted volatile operations are not silently retried, and unpair during a real network outage can leave an inert stale entry on the unreachable peer.

The actual Windows IIS configuration and work VPN have not been tested. Local root/nested-path proxies, reconnect, process restart, offline status, bidirectional jobs/files and revocation are covered by integration tests. No production installation or work machine is changed by this experiment.
