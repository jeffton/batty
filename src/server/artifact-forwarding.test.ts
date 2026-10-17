import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createAttachArtifactsTool,
  artifactRefs,
  reportWithArtifacts,
  mergeResponseArtifacts,
  responseArtifacts,
} from "./artifact-forwarding";
import { encodeRuntimeNotice } from "./runtime-notices";
import { runtimeResultArtifacts } from "./runtime-result-artifacts";

const diff = { path: "/repo/a.ts", patch: "--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-old\n+new\n" };
const site = {
  kind: "site" as const,
  id: "site-id",
  name: "Demo",
  url: "https://example.test/demo",
  public: false as const,
};
const other = { ...site, id: "draft", name: "Discarded" };
const browser = {
  kind: "browser" as const,
  id: "browser-live",
  browserId: "live",
  name: "Cloud browser",
  url: "/api/cloud-browser/live/state",
  public: false as const,
};

function apiFor(messages: unknown[]) {
  return {
    conversationId: 1,
    commit: async (fn: any) =>
      fn({
        scanEntries: async (query: unknown) => {
          expect(query).toEqual({ conversationId: 1 });
          return { items: [{ model: messages }] };
        },
      }),
  } as never;
}

test.each(["notice", "sync", "codemode"])(
  "forwards only selected saved objects received via %s, including replay",
  async (source) => {
    const artifacts = { fileChanges: [diff], sites: [site, browser, other] };
    const messages =
      source === "notice"
        ? [
            {
              role: "user",
              content: encodeRuntimeNotice({
                kind: "cron",
                text: "report",
                data: { runtimeResultArtifacts: artifacts },
              }),
            },
          ]
        : [
            {
              role: "toolResult",
              details:
                source === "sync" ? artifacts : { calls: [{ name: "subagent", ...artifacts }] },
            },
          ];
    const refs = artifactRefs({ fileChanges: [diff], sites: [site, browser] }).map(
      (item) => item.ref,
    );
    const tool = createAttachArtifactsTool();
    const result = await tool.execute({ refs }, apiFor(messages), context);
    expect(result.details).toEqual({
      fileChanges: [diff],
      sites: [site, browser],
      forwardedArtifacts: { fileChanges: [diff], sites: [site, browser] },
    });
    expect(await tool.execute({ refs }, apiFor(messages), context)).toEqual(result);
    expect(
      runtimeResultArtifacts([
        { model: [{ role: "toolResult", details: result.details }] } as never,
      ]).fileChanges,
    ).toEqual([diff]);
  },
);

test("forwarding adds to existing response metadata without removing sites or duplicating objects", () => {
  expect(mergeResponseArtifacts({ sites: [site] }, { fileChanges: [diff] })).toEqual({
    fileChanges: [diff],
    sites: [site],
  });
  expect(
    mergeResponseArtifacts(
      { fileChanges: [diff], sites: [site] },
      { fileChanges: [diff], sites: [other] },
    ),
  ).toEqual({ fileChanges: [diff], sites: [site, other] });
});

test("native browser attachments belong to their response without forwarding received worker browsers", () => {
  const received = { ...browser, id: "received", browserId: "worker" };
  const selected = { ...browser, id: "selected", browserId: "forwarded" };
  const entries = [
    {
      model: [
        { role: "toolResult", toolName: "browser", details: { sites: [browser] } },
        { role: "toolResult", toolName: "browser", details: { sites: [browser] } },
        { role: "toolResult", toolName: "subagent", details: { sites: [received] } },
        {
          role: "toolResult",
          toolName: "codemode",
          details: {
            sites: [received, browser],
            calls: [
              { name: "subagent", sites: [received] },
              { name: "browser", details: { sites: [browser] } },
            ],
          },
        },
        {
          role: "toolResult",
          toolName: "attach_artifacts",
          details: {
            forwardedArtifacts: { sites: [selected] },
          },
        },
      ],
    },
  ] as never;
  expect(responseArtifacts(entries)).toEqual({ sites: [selected, browser] });
});

test("rejects unreceived refs rather than loading another workspace or fabricating an artifact", async () => {
  await expect(
    createAttachArtifactsTool().execute(
      { refs: artifactRefs({ sites: [site] }).map((item) => item.ref) },
      apiFor([]),
      context,
    ),
  ).rejects.toThrow("not received in this conversation");
});

test("report lists stable version-specific refs without dumping patches or pretending links attach", () => {
  const report = reportWithArtifacts("Ready", { fileChanges: [diff], sites: [site] });
  expect(report).toContain(artifactRefs({ fileChanges: [diff] })[0]!.ref);
  expect(report).toContain("call attach_artifacts");
  expect(report).toContain(site.name);
  expect(report).not.toContain(diff.patch);
  expect(artifactRefs({ fileChanges: [{ ...diff, patch: "different version" }] })[0]!.ref).not.toBe(
    artifactRefs({ fileChanges: [diff] })[0]!.ref,
  );
});
