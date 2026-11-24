import { expect, test } from "vite-plus/test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { runtimeResultArtifacts, subagentReportArtifacts } from "./runtime-result-artifacts";
import { encodeRuntimeNotice } from "./runtime-notices";

const file = {
  id: "f",
  name: "Cabin.jpg",
  size: 1,
  mimeType: "image/jpeg",
  kind: "image",
  downloadUrl: "/api/sent-files/f",
};
const site = {
  kind: "site" as const,
  id: "s",
  name: "Report",
  url: "https://example.com",
  public: false as const,
};
function entry(model: unknown[]): EntryRecord {
  return { model } as unknown as EntryRecord;
}
test("report attachments keep explicit deliveries but not browser opens or inherited edits", () => {
  const browser = (id: string) => ({
    ...site,
    id,
    browserId: id,
    kind: "browser" as const,
  });
  const opened = browser("opened");
  const attached = browser("attached");
  const diff = { path: "selected.ts", patch: "explicit patch" };
  const child = { path: "child.ts", patch: "inherited patch" };
  const artifacts = subagentReportArtifacts([
    entry([
      { role: "toolResult", toolName: "browser", details: { action: "open", sites: [opened] } },
      { role: "toolResult", toolName: "sites", details: { sites: [site] } },
      {
        role: "toolResult",
        toolName: "subagent",
        details: { fileChanges: [child], forwardedArtifacts: { fileChanges: [child] } },
      },
      {
        role: "toolResult",
        toolName: "codemode",
        details: {
          sites: [attached],
          fileChanges: [child, diff],
          forwardedArtifacts: { fileChanges: [child, diff] },
          calls: [
            { name: "browser", details: { action: "attach", sites: [attached] } },
            { name: "subagent", details: { forwardedArtifacts: { fileChanges: [child] } } },
            { name: "attach_artifacts", details: { forwardedArtifacts: { fileChanges: [diff] } } },
          ],
        },
      },
    ]),
  ]);
  expect(artifacts.sites).toEqual([opened, site, attached]);
  expect(artifacts.fileChanges).toEqual([child, diff]);
  expect(artifacts.reportAttachments).toEqual({ sites: [site, attached], fileChanges: [diff] });
});

test("direct and codemode effects preserve source URLs, deduplicate assets and merge mutation snapshots", () => {
  const artifacts = runtimeResultArtifacts([
    entry([
      {
        role: "toolResult",
        details: {
          sentFiles: [file],
          battyFileChanges: [{ path: "/repo/a.ts", before: "a\n", after: "b\n" }],
        },
      },
    ]),
    entry([
      {
        role: "toolResult",
        details: {
          sentFiles: [file],
          sites: [site, site],
          battyFileChanges: [{ path: "/repo/a.ts", before: "b\n", after: "c\n" }],
        },
      },
    ]),
  ]);
  expect(artifacts.sentFiles).toEqual([file]);
  expect(artifacts.sites).toEqual([site]);
  expect(artifacts.fileChanges).toHaveLength(1);
  expect(artifacts.fileChanges![0]!.patch).toContain("-a\n+c");
  expect(artifacts.fileChanges![0]!.patch).not.toContain("-b");
});
test("old inspection results are not effects, even in a mixed codemode batch", () => {
  const inspected = {
    sentFiles: [file],
    sites: [site],
    fileChanges: [{ path: "old.ts", patch: "old diff" }],
    battyFileChanges: [{ path: "old.ts", before: "a", after: "b" }],
  };
  const ownFile = { ...file, id: "own", name: "new.png" };
  const forwarded = { sites: [site] };
  const artifacts = runtimeResultArtifacts([
    entry([
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "look", name: "subagent", arguments: { action: "inspect" } },
        ],
      },
      { role: "toolResult", toolName: "subagent", toolCallId: "look", details: inspected },
    ]),
    entry([
      {
        role: "toolResult",
        toolName: "codemode",
        details: {
          ...inspected,
          sentFiles: [file, ownFile],
          forwardedArtifacts: forwarded,
          calls: [
            { name: "subagent", args: '{"action":"inspect"}', details: inspected },
            { name: "subagent", args: "undefined", status: "error", details: null },
            { name: "subagent", args: "null", status: "error", details: null },
            { name: "attach_files", args: "{}", details: { sentFiles: [ownFile] } },
            {
              name: "attach_artifacts",
              args: "{}",
              details: { ...forwarded, forwardedArtifacts: forwarded },
            },
          ],
        },
      },
    ]),
  ]);
  expect(artifacts).toEqual({ sentFiles: [ownFile], sites: [site] });
});

test("nested worker assets pass to the cron parent; unchanged mutations have no diff", () => {
  const content = encodeRuntimeNotice({
    kind: "subagent",
    text: "Result",
    data: { runtimeResultArtifacts: { sentFiles: [file], sites: [site] } },
  });
  expect(runtimeResultArtifacts([entry([{ role: "user", content }])])).toEqual({
    sentFiles: [file],
    sites: [site],
  });
  expect(
    runtimeResultArtifacts([
      entry([
        {
          role: "toolResult",
          details: { battyFileChanges: [{ path: "a", before: "a", after: "a" }] },
        },
      ]),
    ]).fileChanges,
  ).toBeUndefined();
});

test("out-of-order delivery preserves actual mutation order through interleaved nested reports", () => {
  const snapshot = (before: string, after: string, order: number) =>
    entry([
      {
        role: "toolResult",
        details: {
          battyFileChanges: [{ path: "a.ts", before: `${before}\n`, after: `${after}\n`, order }],
        },
      },
    ]);
  const child = runtimeResultArtifacts([snapshot("a", "b", 1), snapshot("c", "d", 3)]);
  const parent = runtimeResultArtifacts([
    snapshot("b", "c", 2),
    entry([{ role: "toolResult", details: child }]),
  ]);
  expect(parent.fileChanges![0]!.patch).toContain("-a\n+d");
  expect(parent.battyFileChanges!.map((change) => change.order)).toEqual([1, 2, 3]);
  const duplicated = runtimeResultArtifacts([
    entry([{ role: "toolResult", details: parent }]),
    entry([{ role: "toolResult", details: child }]),
  ]);
  expect(duplicated.battyFileChanges).toHaveLength(3);
  expect(duplicated.fileChanges).toEqual(parent.fileChanges);
});

test.each(["parent-child", "helper-helper"])(
  "overlapping %s edits aggregate the full chronological range",
  (mode) => {
    const snapshot = (before: string, after: string) =>
      entry([
        {
          role: "toolResult",
          details: {
            battyFileChanges: [{ path: "a.ts", before: `${before}\n`, after: `${after}\n` }],
          },
        },
      ]);
    const child = runtimeResultArtifacts([snapshot("b", "c")]);
    const first =
      mode === "parent-child"
        ? snapshot("a", "b")
        : entry([{ role: "toolResult", details: runtimeResultArtifacts([snapshot("a", "b")]) }]);
    const combined = runtimeResultArtifacts([
      first,
      entry([{ role: "toolResult", details: child }]),
    ]);
    expect(combined.fileChanges![0]!.patch).toContain("-a\n+c");
    expect(combined.battyFileChanges).toHaveLength(2);
    const reverted = runtimeResultArtifacts([
      first,
      entry([{ role: "toolResult", details: runtimeResultArtifacts([snapshot("b", "a")]) }]),
    ]);
    expect(reverted.fileChanges).toBeUndefined();
  },
);
