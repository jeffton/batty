import { expect, test } from "vite-plus/test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { SessionState, UiMessage } from "@/shared/types";
import { normalizeMessage } from "./pi-state";
import { TranscriptImages } from "./transcript-images";
import { runtimeResultArtifacts } from "./runtime-result-artifacts";
import { encodeRuntimeNotice } from "./runtime-notices";
import { artifactRefs } from "./artifact-forwarding";

const snapshot = {
  path: "a.ts",
  before: "PRIVATE_SNAPSHOT_BEFORE\n",
  after: "PRIVATE_SNAPSHOT_AFTER\n",
  order: 1,
};
const patch = { path: "a.ts", patch: "immutable visible patch\n" };
const sentFile = {
  id: "f",
  name: "proof.png",
  size: 1,
  mimeType: "image/png",
  kind: "image" as const,
  downloadUrl: "/api/sent-files/f",
};
const site = {
  kind: "site" as const,
  id: "s",
  name: "Proof",
  url: "https://example.com",
  public: false as const,
};
const artifacts = {
  battyFileChanges: [snapshot],
  forwardedArtifacts: { fileChanges: [patch] },
  fileChanges: [patch],
  sentFiles: [sentFile],
  sites: [site],
};
const details = {
  ...artifacts,
  customMetric: { value: 42 },
  calls: [
    {
      name: "edit",
      ...artifacts,
      details: artifacts,
      arguments: { battyFileChanges: "user argument" },
    },
  ],
};

function expectVisible(value: unknown) {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain("PRIVATE_SNAPSHOT");
  expect(serialized).not.toContain('"forwardedArtifacts"');
  expect(serialized).toContain(patch.patch.trim());
  expect(serialized).toContain(sentFile.downloadUrl);
  expect(serialized).toContain(site.url);
}

test("notice/tool projection excludes internal snapshots without changing durable aggregation or immutable refs", () => {
  const content = encodeRuntimeNotice({
    kind: "subagent",
    text: "Ready",
    data: {
      runtimeResultArtifacts: artifacts,
      subagent: { sessionId: "42" },
      runtimeNotice: { markdown: "Ready" },
      customMetric: 42,
    },
  });
  const entries = [{ model: [{ role: "user", content }] }] as unknown as EntryRecord[];
  const original = JSON.stringify(entries);
  const before = runtimeResultArtifacts(entries);
  const notice = normalizeMessage({ role: "user", content, timestamp: 1 }, 0);
  expectVisible(notice);
  expect(notice).toMatchObject({
    data: { subagent: { sessionId: "42" }, runtimeNotice: { markdown: "Ready" }, customMetric: 42 },
  });
  const tool = normalizeMessage(
    {
      role: "toolResult",
      toolCallId: "c",
      toolName: "codemode",
      content: [],
      timestamp: 1,
      isError: false,
      details,
    } as unknown as AgentMessage,
    0,
  );
  expectVisible(tool);
  expect(tool).toMatchObject({
    details: {
      customMetric: { value: 42 },
      calls: [{ arguments: { battyFileChanges: "user argument" } }],
    },
  });
  expect(JSON.stringify(entries)).toBe(original);
  expect(runtimeResultArtifacts(entries)).toEqual(before);
  expect(before.battyFileChanges).toEqual([snapshot]);
  expect(before.forwardedArtifacts).toEqual({ fileChanges: [patch] });
  expect(artifactRefs(before)).toContainEqual(
    expect.objectContaining({ kind: "diff", value: patch }),
  );
  expect(details.calls[0]!.details.battyFileChanges).toEqual([snapshot]);
});

test("worker inspect tool results omit repeated full-file snapshots but retain artifact descriptors", () => {
  const calls = Array.from({ length: 48 }, (_, index) => ({
    name: "codemode",
    details: {
      calls: [
        {
          name: "edit",
          ...artifacts,
          battyFileChanges: Array.from({ length: 5 }, () => ({
            ...snapshot,
            before: "PRIVATE_SNAPSHOT".repeat(500),
            after: "PRIVATE_SNAPSHOT".repeat(500),
          })),
        },
      ],
      durationMs: index,
    },
  }));
  const details = {
    ...artifacts,
    battyFileChanges: [
      { ...snapshot, before: "x".repeat(1_000_000), after: "y".repeat(1_000_000) },
    ],
    subagent: { sessionId: "710056", status: "running" },
    calls,
  };
  const tool = normalizeMessage(
    {
      role: "toolResult",
      toolCallId: "inspect",
      toolName: "subagent",
      content: [],
      timestamp: 1,
      isError: false,
      details,
    } as unknown as AgentMessage,
    0,
  );
  expectVisible(tool);
  expect(tool).toMatchObject({ details: { subagent: details.subagent, fileChanges: [patch] } });
  expect(JSON.stringify(tool).length).toBeLessThan(40_000);
  expect(tool).toMatchObject({
    details: {
      calls: calls.map((call) => ({
        name: "codemode",
        details: {
          durationMs: call.details.durationMs,
          calls: [{ fileChanges: [patch], sentFiles: [sentFile] }],
        },
      })),
    },
  });
  expect(details.calls[47]!.details.calls[0]!.battyFileChanges).toHaveLength(5);
  expect(details.battyFileChanges[0]!.before.length).toBe(1_000_000);
});

test("session event projection sanitizes already-attached remote history and active tool metadata", async () => {
  const messages = [
    {
      id: "1",
      role: "custom",
      customType: "batty-runtime-notice:subagent",
      timestamp: 1,
      text: "Ready",
      data: { runtimeResultArtifacts: artifacts, other: "kept" },
    },
    {
      id: "2",
      role: "toolResult",
      timestamp: 2,
      toolCallId: "c",
      toolName: "codemode",
      blocks: [],
      isError: false,
      details,
    },
  ] as UiMessage[];
  const input = {
    messages,
    activeTools: [
      {
        toolCallId: "c",
        toolName: "codemode",
        args: {},
        blocks: [],
        status: "running",
        isError: false,
        details,
      },
    ],
  } as unknown as SessionState;
  const original = JSON.stringify(input);
  const images = new TranscriptImages("/unused/no-image-blocks");
  expectVisible(await images.messages(messages));
  const state = await images.state(input);
  expectVisible(state);
  expect(state.activeTools[0]!.details).toMatchObject({ customMetric: { value: 42 } });
  expect(JSON.stringify(input)).toBe(original);
});
