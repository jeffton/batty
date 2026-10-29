# Browser maintenance — 2026-10-29

Production uses package-managed Google Chrome Stable **156.0.8078.73** on Linux, with Patchright **1.64.1** as driver. Google's [October 27 release notes](https://chromereleases.googleblog.com/2026/10/stable-channel-update-for-desktop_0562499947.html) document 52 security fixes, including CVE-2026-118320. The [Linux update policy](https://support.google.com/chrome/a/answer/9052345?hl=en) uses Google's APT repository; the existing nightly system-update workflow applies those updates without npm release-age holds. macOS/Windows use installed Chrome Stable and Google Updater. Test fixtures retain pinned Chromium/WebKit.

# Dependency review — 2026-10-26

Reviewed all direct/runtime and development dependencies, catalogs, overrides and pnpm against npm. Selection uses the 4320-minute release age, the existing exclusions and a cutoff of October 23, 09:00 UTC.

## Updates

| Package                                       | Version                                                       |
| --------------------------------------------- | ------------------------------------------------------------- |
| Fastify; multipart; static                    | 5.12.5 → 5.12.7; 10.1.3 → 10.1.6; 10.1.6 → 10.1.7             |
| Source Sans 3; Lucide Vue; Pierre diffs       | 5.3.0 → 5.3.1; 1.54.0 → 1.61.0; 1.5.2 → 1.6.1                 |
| DOMPurify; jsdom; Marked                      | 3.4.16 → 3.4.17; 30.1.2 → 30.1.3; 18.1.0 → 18.1.1             |
| Pinia; TypeBox; unpdf; Virtua                 | 4.0.3 → 4.1.0; 1.3.36 → 1.4.3; 1.8.1 → 1.9.1; 0.53.3 → 0.53.6 |
| Vue/compiler; Vue plugin                      | 3.5.43 → 3.5.44; 6.0.9 → 6.0.10                               |
| Happy DOM                                     | 20.14.6 → 21.0.4                                              |
| Vite Plus and aliased Vite catalog            | 1.1.0 → 1.4.0                                                 |
| fast-uri@3/@4; PostCSS overrides              | 3.1.8 → 3.1.9; 4.2.1 → 4.2.3; 8.5.29 → 8.5.31                 |
| serialize-javascript; find-my-way@9 overrides | 7.1.2 → 7.1.3; 9.9.0 → 9.10.0                                 |
| pnpm                                          | 12.11.2 → 12.15.0                                             |

Happy DOM 21 disables external CSS/iframe loading by default. The site-message bridge fixture uses local `srcdoc` to obtain a real child window without enabling network loading. The secure defaults remain enabled.

Pierre 1.6 changes annotation callbacks, standalone file constructors, theme/highlighter APIs and metadata. Batty uses the unchanged `CodeView` API and parser-produced metadata. TypeBox 1.4 shares subschemas rather than recursively cloning; Batty does not mutate composed schemas. unpdf upgrades PDF.js to 6.4; the existing worker's document/page/text/destruction lifecycle remains compatible. Vue's stricter `defineModel` compilation does not affect Batty's constant options. No application API migration is required.

Vite Plus crosses 1.2.0, 1.3.0 and 1.4.0, including Vitest 5.0.5, Vite 8.3.5, Rolldown 1.2.15 and tsdown 0.23.1. Existing projects, mocks, pack settings and catalog alias remain supported; optional `vpx` adoption is outside this review. pnpm's crossed releases preserve the workspace configuration and deployment's frozen-install workflow.

Fastify's fixes include GHSA-389g-gv7q-r4x8; fast-uri fixes scheme/host/reference normalization vulnerabilities, and serialize-javascript fixes script-end escaping. Updated parent ranges still permit earlier affected versions, so the reviewed overrides remain pinned. Other updates provide compatible rendering, parsing, type, performance and asset fixes.

## Checked versions retained

Pi/Chord's seven packages remain aligned at 1.4.0; no durable schema, task, transcript, queue, provider or lifecycle migration boundary is crossed. Workbox's six packages remain aligned at 7.4.1. Patchright/Playwright Core remain at 1.64.1: installed manifests agree on Chromium 156.0.8078.4 revision 1248 and WebKit 27.2 revision 2370. Patchright 1.64.2 is age-held until October 28, 12:40 UTC; its official release notes are unavailable. serialize-javascript 7.1.4 is age-held until October 26, 14:53 UTC.

Remaining stable pins checked: cookie 11.1.3, websocket 11.3.4, Readability 0.6.0, CSS anchor positioning 0.10.2, WebAuthn browser/server 14.0.0/14.0.3, Croner 10.0.1, Highlight.js 11.12.0, mime-types 3.0.2, persisted-state 4.7.1, Sharp 0.35.5, Turndown/GFM 7.2.4/1.0.2, Vue Router 5.4.0, web-push 3.6.7, jsdom/Node/Turndown/web-push/ws types 30.0.0/26.6.5/5.0.6/3.6.4/8.18.2, Vue test-utils 2.5.1, tsx 4.23.15, TypeScript 7.0.2 and PWA plugin 2.0.0. Maintained-major overrides retain Nano ID 3.3.20 and brace-expansion 2.1.7/5.0.12.

## Validation

`pnpm check`, `pnpm test` (769 passed, 2 skipped), `pnpm test:all` (812 passed, 2 skipped), Linux deployment lifecycle checks, build, packaged startup and offline verification pass. Frozen lockfile installation passes. Independent Sol review found no actionable findings. Ten lint warnings remain; an unchanged lifecycle test logs a caught localhost version-check connection refusal without failed assertions.

## Official sources

All crossed stable release notes/changelog entries were reviewed, including intermediate releases:

- Fastify [5.12.6](https://github.com/fastify/fastify/releases/tag/v5.12.6), [5.12.7](https://github.com/fastify/fastify/releases/tag/v5.12.7); multipart [10.1.4](https://github.com/fastify/fastify-multipart/releases/tag/v10.1.4), [10.1.5](https://github.com/fastify/fastify-multipart/releases/tag/v10.1.5), [10.1.6](https://github.com/fastify/fastify-multipart/releases/tag/v10.1.6); [static 10.1.7](https://github.com/fastify/fastify-static/releases/tag/v10.1.7).
- [Fontsource patch policy](https://github.com/fontsource/fontsource/blob/main/CHANGELOG.md); [Lucide releases](https://github.com/lucide-icons/lucide/releases) (1.55–1.61); Pierre [1.6.0](https://github.com/pierrecomputer/pierre/releases/tag/diffs-v1.6.0), [1.6.1](https://github.com/pierrecomputer/pierre/releases/tag/diffs-v1.6.1).
- [DOMPurify 3.4.17](https://github.com/cure53/DOMPurify/releases/tag/3.4.17), [jsdom 30.1.3](https://github.com/jsdom/jsdom/releases/tag/v30.1.3), [Marked 18.1.1](https://github.com/markedjs/marked/releases/tag/v18.1.1), [Pinia 4.1.0](https://github.com/vuejs/pinia/releases/tag/v4.1.0).
- TypeBox changelogs [1.3.37](https://github.com/sinclairzx81/typebox/blob/main/changelog/1.3.0.md), [1.4.0–1.4.3](https://github.com/sinclairzx81/typebox/blob/main/changelog/1.4.0.md); unpdf [1.9.0](https://github.com/unjs/unpdf/releases/tag/v1.9.0), [1.9.1](https://github.com/unjs/unpdf/releases/tag/v1.9.1); [Virtua releases](https://github.com/inokawa/virtua/releases) (0.53.4–0.53.6).
- [Vue 3.5.44 changelog](https://github.com/vuejs/core/blob/v3.5.44/CHANGELOG.md), [Vue plugin 6.0.10 changelog](https://github.com/vitejs/vite-plugin-vue/blob/plugin-vue@6.0.10/packages/plugin-vue/CHANGELOG.md); [Happy DOM releases](https://github.com/capricorn86/happy-dom/releases) (21.0.0–21.0.4).
- Vite Plus [1.2.0](https://github.com/voidzero-dev/vite-plus/releases/tag/v1.2.0), [1.3.0](https://github.com/voidzero-dev/vite-plus/releases/tag/v1.3.0), [1.4.0](https://github.com/voidzero-dev/vite-plus/releases/tag/v1.4.0); [pnpm releases](https://github.com/pnpm/pnpm/releases) (12.12.0, 12.12.1, 12.13.0, 12.14.0, 12.15.0).
- fast-uri [3.1.9](https://github.com/fastify/fast-uri/releases/tag/v3.1.9), [4.2.2](https://github.com/fastify/fast-uri/releases/tag/v4.2.2), [4.2.3](https://github.com/fastify/fast-uri/releases/tag/v4.2.3); [PostCSS changelog](https://github.com/postcss/postcss/blob/8.5.31/CHANGELOG.md) (8.5.30–8.5.31); [serialize-javascript 7.1.3](https://github.com/yahoo/serialize-javascript/releases/tag/v7.1.3); [find-my-way 9.10.0](https://github.com/delvedor/find-my-way/releases/tag/v9.10.0).
- [Patchright 1.64.1 upstream declaration](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright/releases/tag/v1.64.1) and npm registry release timestamps for every reviewed package.

# Pi dependency review — 2026-10-22

All seven Pi/Chord packages: **1.2.0 → 1.4.0**, pinned together at the current stable release. Durable's SQLite schema 2 rebuilds the task table and prevents opening it with older SDKs; deployment requires a verified SQLite-aware backup and space for the table rewrite. Rollback across this boundary requires restoring that backup, not merely selecting an older release.

Batty declares explicit document checkpoint policies, retaining delta storage and existing periodic policies. Delivery retries use persistent `sleepUntil()` with the existing checkpoint; nested tools expose the harness clock through `now()`. Sleeping tasks remain nonterminal in worker/cron status handling. Runtime reports include task/reason metadata for crash-loop parkings. Codemode retains worker ownership until `onWorkerStarted`'s exit promise settles, since SDK `close()` requests shutdown without waiting for exit.

Chord's removed object/link APIs and Pi AI's removed frame/transcript-tool APIs are not used by Batty. Existing Contexts come from Chord. The built-in generation/backoff task migrations are upstream-owned; Batty's task identities/checkpoints remain unchanged. No host compatibility layer or history conversion is introduced.

Regression coverage includes a real 1.2 SQLite fixture migrating without rewriting persisted records, sleeping task recovery, and an actual interrupted process reaching the restart limit followed by explicit retry. Existing nested-tool replay/cancellation, worker/cron recovery, memory and browser tests exercise the updated package set.

Sources: [Pi 1.4.0](https://github.com/earendil-works/pi/releases/tag/v1.4.0), [Durable changelog](https://github.com/earendil-works/pi/blob/v1.4.0/packages/durable/CHANGELOG.md), [Chord changelog](https://github.com/earendil-works/pi/blob/v1.4.0/packages/chord/CHANGELOG.md), [Codemode changelog](https://github.com/earendil-works/pi/blob/v1.4.0/packages/codemode/CHANGELOG.md), [AI changelog](https://github.com/earendil-works/pi/blob/v1.4.0/packages/ai/CHANGELOG.md).

# Browser dependency review — 2026-10-22

Patchright and Playwright Core: **1.63.0 → 1.64.1**. Both installed browser manifests pin Chromium **156.0.8078.4**, revision **1248**, and WebKit **27.2**, revision **2370**. Chromium is deployed through the existing isolated-browser setup; WebKit is used for tests. Isolation grants read/traverse permissions to root-owned browser files copied from a private installer cache, while retaining the prohibition on non-root writes.

Patchright 1.64.1 follows Playwright 1.64.1. Playwright 1.64 adds WebMCP, recording and locator APIs; 1.64.1 fixes routed cross-origin redirects and Electron startup. Its breaking changes affect device-descriptor screen emulation, JSX test compilation, snapshot-update modes and hidden-iframe visibility. Batty does not use Playwright Test's JSX/snapshot runner; browser regressions cover the integration.

The live-attachment fixture closes all owned backend connections during teardown: Chromium 156 can leave speculative TCP connections without an HTTP request. No runtime timeout or retry changes are required.

Validation: `pnpm check`, all 760 tests (2 skips), Linux deployment regression checks, production build, startup and offline verification pass, including Chromium isolation and WebKit H.264 coverage.

Dependency reviews check Patchright's current upstream release and browser revisions together. Historical version holds are not maintenance instructions; `AGENTS.md` defines the recurring checks.

Sources: [Patchright 1.64.1](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright/releases/tag/v1.64.1), [Playwright 1.64.0](https://github.com/microsoft/playwright/releases/tag/v1.64.0), [Playwright 1.64.1](https://github.com/microsoft/playwright/releases/tag/v1.64.1).

# Dependency review — 2026-10-13

Direct dependencies, development dependencies, catalogs, overrides and pnpm were checked against npm. Updates honor the 4320-minute minimum release age and explicit Pi/Chord exclusions.

## Updates

| Package                                           | Version           |
| ------------------------------------------------- | ----------------- |
| All seven `@earendil-works/pi-*` / Chord packages | 1.1.0 → 1.2.0     |
| `@fastify/static`                                 | 10.1.5 → 10.1.6   |
| `@types/node`                                     | 26.6.4 → 26.6.5   |
| pnpm                                              | 12.11.0 → 12.11.2 |

## Integration

Pi Durable's `ToolExecutionResult.content` becomes `output`; Batty's coding-agent bridge, MCP bridge, memory, orchestration, artifact forwarding, codemode and test tools use that boundary. Transcript messages and coding-agent/MCP results retain `content`. Codemode's nested API retains streamed output and diagnostics and supports the new `retainedOutput()` and durable `executeTool()` methods. Regression coverage exercises streamed results, delegation in the conversation's working directory, structured program output, unsafe restart abandonment and cancellation of unawaited child calls. Batty's nested task uses version 2 and native `output` receipts. Version 1 task migration and `content` receipt conversion are unsupported.

The built-in `pi.tool` task migrates version 1 live tasks to its model/nested tagged unions. Batty does not inspect those input/result fields. Batty uses upstream SQLite storage and Chord's retained JSON/context APIs, not the removed service/facet runtime. Existing restart, replay, cancellation, transcript, queue, cron, memory and artifact tests cover these boundaries. Display-only submissions, stricter storage-failure behavior, scheduler/cache fixes and compaction failures are inherited from Durable.

Coding-agent startup hooks and theme schemas are not used by Batty. Its custom read/mutation/shell bridges retain the coding-agent contracts, including nonzero shell exits; Durable's native shell return-shape change does not change Batty's shell result contract. Codemode retains explicit MCP result declarations, compatible with arbitrary JSON structured content. The provider retry, auth, stream and MCP cancellation fixes are inherited without configuration changes.

Fastify Static's patch changes release publishing only. Node declarations permit hex colors in `util.styleText()` format arrays and require no Batty source changes. pnpm 12.11.1/12.11.2 fix installation, registry and workspace handling; Batty's catalog and deployment setup are unchanged.

Validation: `pnpm check`, all 511 tests (2 Windows-only skips), Linux deployment regression checks, production build and offline browser verification pass. Existing lint and build warnings remain.

## Held versions

Release age holds Source Sans 3 5.3.1, Lucide 1.55.0, DOMPurify 3.4.17, Marked 18.1.1, TypeBox 1.3.37, Virtua 0.53.4/0.53.5, Vue plugin 6.0.10, Happy DOM 21.0.0/21.0.1, pnpm 12.12.0/12.12.1, fast-uri@4 4.2.2, PostCSS 8.5.30 and find-my-way@9 9.10.0. Remaining direct packages, catalogs and maintained-major overrides are current under the policy; no override removal is warranted.

## Official sources

- [Pi 1.2.0 release](https://github.com/earendil-works/pi/releases/tag/v1.2.0) and tagged changelogs: [Durable](https://github.com/earendil-works/pi/blob/v1.2.0/packages/durable/CHANGELOG.md), [Chord](https://github.com/earendil-works/pi/blob/v1.2.0/packages/chord/CHANGELOG.md), [AI](https://github.com/earendil-works/pi/blob/v1.2.0/packages/ai/CHANGELOG.md), [agent](https://github.com/earendil-works/pi/blob/v1.2.0/packages/agent/CHANGELOG.md), [codemode](https://github.com/earendil-works/pi/blob/v1.2.0/packages/codemode/CHANGELOG.md), [coding agent](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/CHANGELOG.md), [MCP](https://github.com/earendil-works/pi/blob/v1.2.0/packages/mcp/CHANGELOG.md).
- [Fastify Static 10.1.6](https://github.com/fastify/fastify-static/releases/tag/v10.1.6), [Node declarations](https://github.com/DefinitelyTyped/DefinitelyTyped/commit/8cbe9250b21658bb36f7995a0b5cddcc22c8aa2e), [pnpm 12.11.1](https://github.com/pnpm/pnpm/releases/tag/v12.11.1), [pnpm 12.11.2](https://github.com/pnpm/pnpm/releases/tag/v12.11.2).

# Dependency review — 2026-10-12

Direct dependencies, development dependencies, catalog entries, overrides and pnpm were checked against npm. Selection honors the 4320-minute minimum release age and workspace exclusions.

## Updates

| Package                                           | Version                                          |
| ------------------------------------------------- | ------------------------------------------------ |
| All seven `@earendil-works/pi-*` / Chord packages | 1.0.2 → 1.1.0                                    |
| `@fastify/cookie`, `@fastify/multipart`           | 11.1.2 → 11.1.3; 10.1.2 → 10.1.3                 |
| `@lucide/vue`                                     | 1.49.0 → 1.54.0                                  |
| `@pierre/diffs`                                   | 1.5.1 → 1.5.2                                    |
| `jsdom`, `marked`                                 | 30.1.1 → 30.1.2; 18.0.14 → 18.1.0                |
| `typebox`, `virtua`, `vue-router`                 | 1.3.34 → 1.3.36; 0.52.10 → 0.53.3; 5.3.1 → 5.4.0 |
| `@types/node`, `happy-dom`                        | 26.6.3 → 26.6.4; 20.14.5 → 20.14.6               |
| Vite Plus and aliased Vite catalog                | 1.0.0 → 1.1.0                                    |
| `vite-plugin-pwa`, pnpm                           | 1.3.0 → 2.0.0; 12.8.1 → 12.11.0                  |
| `nanoid@3`, `postcss`, `find-my-way@9` overrides  | 3.3.18 → 3.3.20; 8.5.26 → 8.5.29; 9.7.0 → 9.9.0  |

The unused `shell-quote` override is removed. Maintained-major overrides remain scoped; upstream parent ranges still permit older releases.

## Integration

Pi's crossed releases are 1.0.3, 1.0.4 and 1.1.0. Nested codemode tool APIs expose the harness model catalog and explicitly disable environment output-window omission: they retain returned content, not a running-output tail. MCP authorization cancellation and disposal abort discovery/token exchange through Pi's sign-in signal. Regression tests cover nested model resolution/shell output and cancellation before the redirect prompt.

Breaking upstream changes reviewed:

- Pi renames the Azure **provider** to `azure`, but retains the `azure-openai-responses` API ID. Batty source, deployed root JSON configuration and durable records contain no old provider field.
- Custom environments require binary/directory readers, watch support and argv execution; custom storage must implement ordered scans. Batty uses upstream `NodeExecutionEnv` and SQLite storage.
- `TaskRuntime.context()` uses `{ at }`; Batty uses compatible conversation context calls. Scan defaults and opaque cursors remain compatible.
- Streams require `AssistantMessageEventStream`; Batty retains ModelRuntime's stream. Context caching freezes messages and keeps the baseline system message first; Batty's request hooks construct replacements. Existing transcript, queue, compaction, retry and reopen tests exercise the integration.
- Task wall-clock timing differs from response/tool execution duration; no timing UI migration is required. Provider retry and catalog fixes are inherited, and the picker stays chat-only.
- PWA 2 requires Node ≥20.19; Batty requires ≥24.15. Experimental router query changes do not affect Batty's standard router. Virtua's horizontal VList changes do not affect its vertical Virtualizer.
- Vite Plus's formatter requires a CSS-only formatting adjustment. pnpm keeps the existing catalog, alias, build approvals and deployment installation workflow.

Validation fixtures supply the required memory language, mock lifecycle version checks and stub the site preview in an action-stack test, avoiding real network requests and settings-render errors during offline/Happy DOM checks.

Validation: `pnpm check`, all 499 tests across 95 files, `pnpm build`, offline verification and deployment lifecycle tests pass. The full suite runs serially as in deployment; a concurrent run hit two browser-render timeouts that passed in isolation and serially. Nine existing lint warnings and build chunk-size/PWA deprecation warnings remain.

## Held versions

Age policy holds `@fastify/static` 10.1.5 (latest 10.1.6), Source Sans 3 5.3.0 (5.3.1), Vue plugin 6.0.9 (6.0.10), Lucide at 1.54.0 (1.55.0), Virtua at 0.53.3 (0.53.4), Node types at 26.6.4 (26.6.5), Happy DOM at 20.14.6 (21.0.1), `fast-uri@4` 4.2.1 (4.2.2), `find-my-way@9` at 9.9.0 (9.10.0) and pnpm at 12.11.0 (12.11.2).

Other checked packages are current: Readability 0.6.0; CSS anchor positioning 0.10.2; WebAuthn browser/server 14.0.0/14.0.3; Croner 10.0.1; DOMPurify 3.4.16; Fastify 5.12.5; Highlight.js 11.12.0; mime-types 3.0.2; Pinia 4.0.3 and persisted-state 4.7.1; Sharp 0.35.5; Turndown 7.2.4 and GFM 1.0.2; unpdf 1.8.1; Vue/compiler 3.5.43; web-push 3.6.7; all six Workbox packages 7.4.1; jsdom/Turndown/web-push types 30.0.0/5.0.6/3.6.4; Vue test-utils 2.5.1; tsx 4.23.15; TypeScript 7.0.2. Retained overrides: fast-uri@3 3.1.8, serialize-javascript 7.1.2, brace-expansion@2/@5 2.1.7/5.0.12, Vue compiler and Vite alias.

## Official sources

Every crossed release was reviewed, including intermediate releases:

- [Pi release](https://github.com/earendil-works/pi/releases/tag/v1.1.0) and tagged changelogs for [AI](https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/CHANGELOG.md), [agent](https://github.com/earendil-works/pi/blob/v1.1.0/packages/agent/CHANGELOG.md), [coding agent](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/CHANGELOG.md), [durable](https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/CHANGELOG.md), [codemode](https://github.com/earendil-works/pi/blob/v1.1.0/packages/codemode/CHANGELOG.md), [MCP](https://github.com/earendil-works/pi/blob/v1.1.0/packages/mcp/CHANGELOG.md) and [Chord comparison](https://github.com/earendil-works/pi/compare/v1.0.2...v1.1.0).
- [Vite Plus 1.1.0](https://github.com/voidzero-dev/vite-plus/releases/tag/v1.1.0), [PWA 2.0.0](https://github.com/vite-pwa/vite-plugin-pwa/releases/tag/v2.0.0), [pnpm releases](https://github.com/pnpm/pnpm/releases) (12.8.2, 12.9.0, 12.9.1, 12.10.0, 12.10.1, 12.11.0).
- [Cookie 11.1.3](https://github.com/fastify/fastify-cookie/releases/tag/v11.1.3), [multipart 10.1.3](https://github.com/fastify/fastify-multipart/releases/tag/v10.1.3), [Lucide releases](https://github.com/lucide-icons/lucide/releases) (1.50–1.54), [diffs 1.5.2](https://github.com/pierrecomputer/pierre/releases/tag/diffs-v1.5.2).
- [jsdom 30.1.2](https://github.com/jsdom/jsdom/releases/tag/v30.1.2), [Marked 18.1.0](https://github.com/markedjs/marked/releases/tag/v18.1.0), [TypeBox releases](https://github.com/sinclairzx81/typebox/releases) (1.3.35–1.3.36), [Virtua releases](https://github.com/inokawa/virtua/releases) (0.53.0–0.53.3), [router 5.4.0](https://github.com/vuejs/router/releases/tag/v5.4.0).
- [Node declarations](https://github.com/DefinitelyTyped/DefinitelyTyped/commit/57ddf7c02e59563a0736a9019df35173c8cd4739), [Happy DOM 20.14.6 security fix](https://github.com/capricorn86/happy-dom/releases/tag/v20.14.6), [Patchright alignment](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright/releases/tag/v1.63.0).
- [Nano ID releases](https://github.com/ai/nanoid/releases) (3.3.19–3.3.20), [PostCSS releases](https://github.com/postcss/postcss/releases) (8.5.27–8.5.29), [find-my-way releases](https://github.com/delvedor/find-my-way/releases) (9.8.0–9.9.0), [shell-quote changelog](https://github.com/ljharb/shell-quote/blob/main/CHANGELOG.md).
