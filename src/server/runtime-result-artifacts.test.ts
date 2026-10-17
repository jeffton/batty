import { expect, test } from "vite-plus/test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { runtimeResultArtifacts } from "./runtime-result-artifacts";
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
