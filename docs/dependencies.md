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

Pi Durable's `ToolExecutionResult.content` becomes `output`; Batty's coding-agent bridge, MCP bridge, memory, orchestration, artifact forwarding, codemode and test tools use that boundary. Transcript messages and coding-agent/MCP results retain `content`. Codemode's nested API retains streamed output and diagnostics and supports the new `retainedOutput()` and durable `executeTool()` methods. Regression coverage exercises streamed results, delegation in the conversation's working directory, structured program output, unsafe restart abandonment and cancellation of unawaited child calls. Batty's nested task moves to version 2; its receipt migration preserves completed version 1 output when interrupted scripts reopen.

The built-in `pi.tool` task migrates version 1 live tasks to its model/nested tagged unions. Batty does not inspect those input/result fields. Batty uses upstream SQLite storage and Chord's retained JSON/context APIs, not the removed service/facet runtime. Existing restart, replay, cancellation, transcript, queue, cron, memory and artifact tests cover these boundaries. Display-only submissions, stricter storage-failure behavior, scheduler/cache fixes and compaction failures are inherited from Durable.

Coding-agent startup hooks and theme schemas are not used by Batty. Its custom read/mutation/shell bridges retain the coding-agent contracts, including nonzero shell exits; Durable's native shell return-shape change does not change Batty's shell result contract. Codemode retains explicit MCP result declarations, compatible with arbitrary JSON structured content. The provider retry, auth, stream and MCP cancellation fixes are inherited without configuration changes.

Fastify Static's patch changes release publishing only. Node declarations permit hex colors in `util.styleText()` format arrays and require no Batty source changes. pnpm 12.11.1/12.11.2 fix installation, registry and workspace handling; Batty's catalog and deployment setup are unchanged.

Validation: `pnpm check`, all 511 tests (2 Windows-only skips), Linux deployment regression checks, production build and offline browser verification pass. Existing lint and build warnings remain.

## Held versions

Playwright Core stays at 1.63.0 to match Patchright 1.63.0. Release age holds Source Sans 3 5.3.1, Lucide 1.55.0, DOMPurify 3.4.17, Marked 18.1.1, TypeBox 1.3.37, Virtua 0.53.4/0.53.5, Vue plugin 6.0.10, Happy DOM 21.0.0/21.0.1, pnpm 12.12.0/12.12.1, fast-uri@4 4.2.2, PostCSS 8.5.30 and find-my-way@9 9.10.0. Remaining direct packages, catalogs and maintained-major overrides are current under the policy; no override removal is warranted.

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

Playwright Core remains 1.63.0 despite eligible 1.64.0, matching Patchright/patchright-core 1.63.0 and their browser revisions.

Other checked packages are current: Readability 0.6.0; CSS anchor positioning 0.10.2; WebAuthn browser/server 14.0.0/14.0.3; Croner 10.0.1; DOMPurify 3.4.16; Fastify 5.12.5; Highlight.js 11.12.0; mime-types 3.0.2; Pinia 4.0.3 and persisted-state 4.7.1; Sharp 0.35.5; Turndown 7.2.4 and GFM 1.0.2; unpdf 1.8.1; Vue/compiler 3.5.43; web-push 3.6.7; all six Workbox packages 7.4.1; jsdom/Turndown/web-push types 30.0.0/5.0.6/3.6.4; Vue test-utils 2.5.1; tsx 4.23.15; TypeScript 7.0.2. Retained overrides: fast-uri@3 3.1.8, serialize-javascript 7.1.2, brace-expansion@2/@5 2.1.7/5.0.12, Vue compiler and Vite alias.

## Official sources

Every crossed release was reviewed, including intermediate releases:

- [Pi release](https://github.com/earendil-works/pi/releases/tag/v1.1.0) and tagged changelogs for [AI](https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/CHANGELOG.md), [agent](https://github.com/earendil-works/pi/blob/v1.1.0/packages/agent/CHANGELOG.md), [coding agent](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/CHANGELOG.md), [durable](https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/CHANGELOG.md), [codemode](https://github.com/earendil-works/pi/blob/v1.1.0/packages/codemode/CHANGELOG.md), [MCP](https://github.com/earendil-works/pi/blob/v1.1.0/packages/mcp/CHANGELOG.md) and [Chord comparison](https://github.com/earendil-works/pi/compare/v1.0.2...v1.1.0).
- [Vite Plus 1.1.0](https://github.com/voidzero-dev/vite-plus/releases/tag/v1.1.0), [PWA 2.0.0](https://github.com/vite-pwa/vite-plugin-pwa/releases/tag/v2.0.0), [pnpm releases](https://github.com/pnpm/pnpm/releases) (12.8.2, 12.9.0, 12.9.1, 12.10.0, 12.10.1, 12.11.0).
- [Cookie 11.1.3](https://github.com/fastify/fastify-cookie/releases/tag/v11.1.3), [multipart 10.1.3](https://github.com/fastify/fastify-multipart/releases/tag/v10.1.3), [Lucide releases](https://github.com/lucide-icons/lucide/releases) (1.50–1.54), [diffs 1.5.2](https://github.com/pierrecomputer/pierre/releases/tag/diffs-v1.5.2).
- [jsdom 30.1.2](https://github.com/jsdom/jsdom/releases/tag/v30.1.2), [Marked 18.1.0](https://github.com/markedjs/marked/releases/tag/v18.1.0), [TypeBox releases](https://github.com/sinclairzx81/typebox/releases) (1.3.35–1.3.36), [Virtua releases](https://github.com/inokawa/virtua/releases) (0.53.0–0.53.3), [router 5.4.0](https://github.com/vuejs/router/releases/tag/v5.4.0).
- [Node declarations](https://github.com/DefinitelyTyped/DefinitelyTyped/commit/57ddf7c02e59563a0736a9019df35173c8cd4739), [Happy DOM 20.14.6 security fix](https://github.com/capricorn86/happy-dom/releases/tag/v20.14.6), [Patchright alignment](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright/releases/tag/v1.63.0).
- [Nano ID releases](https://github.com/ai/nanoid/releases) (3.3.19–3.3.20), [PostCSS releases](https://github.com/postcss/postcss/releases) (8.5.27–8.5.29), [find-my-way releases](https://github.com/delvedor/find-my-way/releases) (9.8.0–9.9.0), [shell-quote changelog](https://github.com/ljharb/shell-quote/blob/main/CHANGELOG.md).
