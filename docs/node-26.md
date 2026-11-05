# Node 26 LTS

Batty requires Node 26.13.0 or later. pnpm remains pinned to 12.16.1; install Corepack 0.36.0 separately because Node stopped bundling it in version 25. Installations must upgrade their external Node runtime before deploying this commit.

Reviewed upstream changes:

- [Node 25](https://nodejs.org/en/blog/release/v25.0.0): Corepack removal, default Web Storage, native-module ABI changes and removed deprecated APIs.
- [Node 26](https://nodejs.org/en/blog/release/v26.0.0): V8 14.6, Temporal, Undici 8, removed legacy stream modules and `writeHeader`, deprecated `module.register()`.
- [26.13.0 LTS](https://nodejs.org/en/blog/release/v26.13.0).
- [Corepack 0.36.0](https://github.com/nodejs/corepack/releases/tag/v0.36.0).

Dependency versions and lockfile remain unchanged. The validation gates exercise SQLite/durable replay, PDF workers, Sharp, HTTP/TLS clients, agent subprocesses, browser tools and packaged startup/offline behavior on the selected runtime. This upgrade is independent of the security release announced for 11 November; that release still needs to be applied when available.
