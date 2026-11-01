import { expect, test } from "vite-plus/test";
import type { Storage } from "@earendil-works/pi-durable";
import type { UiMessage } from "@/shared/types";
import { hydrateRuntimeResultArtifacts } from "./runtime-result-artifacts-history";

test("already-attached report artifacts are projected without storage access or source mutation", async () => {
  const artifacts = {
    battyFileChanges: [{ path: "a", before: "source", after: "updated" }],
    forwardedArtifacts: { fileChanges: [{ path: "a", patch: "immutable" }] },
    fileChanges: [{ path: "a", patch: "immutable" }],
    customMetric: 42,
  };
  const data = {
    runtimeResultArtifacts: artifacts,
    runtimeNotice: { markdown: "Done" },
    subagent: { sessionId: "42" },
  };
  const message: UiMessage = {
    id: "100",
    role: "custom",
    timestamp: 1,
    customType: "batty-runtime-notice:subagent",
    text: "Done",
    data,
  };
  await hydrateRuntimeResultArtifacts({} as Storage, 1 as never, message);
  expect(message.data).toEqual({
    ...data,
    runtimeResultArtifacts: { fileChanges: artifacts.fileChanges, customMetric: 42 },
  });
  expect(data.runtimeResultArtifacts).toBe(artifacts);
  expect(artifacts.battyFileChanges).toHaveLength(1);
  expect(artifacts.forwardedArtifacts).toBeDefined();
});
