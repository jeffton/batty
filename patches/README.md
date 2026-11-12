# Dependency patches

## pi-durable 1.5.0: recent-work retention

`selectCut` counts user, assistant and tool-result tokens toward `keepRecentTokens`, excluding system instructions and tool schemas. These form the replayed baseline, not recent conversation work.

Workers inject pinned main-memory background in `beforeRequest`. Provider usage correctly includes this background and can reach the compaction threshold while the worker's own task is still short. Counting a large system/tool baseline as recent work lets native compaction replace the task before its first tool result. Repeated compaction then loses investigation progress.

The patch preserves full-request usage, thresholds, pinned background and native compaction for long conversations. It changes only selection of the retained work. `src/server/compaction-retention.test.ts` exercises repeated tool rounds, persistence across restart, unchanged measured usage and compaction of genuinely long work. Remove the patch when upstream provides equivalent retention accounting.
