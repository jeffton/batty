# Dependency patches

## patchright-core 1.64.3: context-less service workers

Chrome can report an existing service worker without `browserContextId` during CDP reconnect. Patchright asserts on that optional field inside its event handler, killing the host process. This occurred with Amazon\u2019s service worker after a Batty restart.

The patch detaches only context-less service-worker targets. Detaching resumes workers paused by auto-attach; ordinary pages and service workers retain their existing handling. No worker registration, cache, cookies or profile data is removed. `src/server/browser-cdp-worker.test.ts` exercises the installed library in a child process against the observed CDP target shape and checks resume/detach.

Upstream: https://github.com/microsoft/playwright/issues/43638. Remove the patch when the dependency handles this target shape without crashing.

## pi-durable 1.6.0: recent-work retention and context estimation

`selectCut` counts user, assistant and tool-result tokens toward `keepRecentTokens`, excluding system instructions and tool schemas. These form the replayed baseline, not recent conversation work.

Workers inject pinned main-memory background in `beforeRequest`. Provider usage correctly includes this background and can reach the compaction threshold while the worker's own task is still short. Counting a large system/tool baseline as recent work lets native compaction replace the task before its first tool result. Repeated compaction then loses investigation progress.

The patch preserves full-request usage, thresholds, pinned background and native compaction for long conversations. It excludes the replayed baseline when selecting retained work and exposes `beforeContextEstimate` for model-visible projection during estimation and range selection. The projection does not change stored history. `src/server/runtime-notice-provider.test.ts` covers estimation and projection. `src/server/compaction-retention.test.ts` exercises repeated tool rounds, persistence across restart, unchanged measured usage and compaction of genuinely long work. Remove the patch when upstream provides equivalent retention accounting.
