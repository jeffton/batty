import { expect, test } from "vite-plus/test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  artifactRefs,
  createAttachArtifactsTool,
  reportWithArtifacts,
} from "./artifact-forwarding";
import { runtimeResultArtifacts } from "./runtime-result-artifacts";
import { encodeRuntimeNotice } from "./runtime-notices";

const first = { path: "a.ts", patch: "first immutable patch\n" };
const second = { path: "a.ts", patch: "second immutable patch\n" };
const file = {
  id: "original-id",
  name: "original.png",
  size: 42,
  mimeType: "image/png",
  kind: "image" as const,
  downloadUrl: "/api/sent-files/original-id",
};
const inventory = { fileChanges: [first, second], sentFiles: [file] };
const entry = (details: unknown) =>
  ({ model: [{ role: "toolResult", details }] }) as unknown as EntryRecord;
const apiFor = (messages: unknown[]) =>
  ({
    conversationId: 1,
    commit: async (fn: any) => fn({ scanEntries: async () => ({ items: [{ model: messages }] }) }),
  }) as never;

test.each(["async", "sync", "await", "codemode", "codemode-flat", "direct-cron"])(
  "%s artifact forwarding reuses original file and same-path diffs across two parents and replay",
  async (source) => {
    const messages =
      source === "async" || source === "direct-cron"
        ? [
            {
              role: "user",
              content: encodeRuntimeNotice({
                kind: source === "async" ? "subagent" : "cron",
                text: reportWithArtifacts("Ready", inventory),
                data: { runtimeResultArtifacts: inventory },
              }),
            },
          ]
        : [
            {
              role: "toolResult",
              details:
                source === "codemode"
                  ? { calls: [{ details: inventory }] }
                  : source === "codemode-flat"
                    ? { calls: [{ name: "subagent", ...inventory }] }
                    : inventory,
            },
          ];
    const refs = artifactRefs(inventory).map((item) => item.ref);
    const tool = createAttachArtifactsTool();
    const attached = await tool.execute({ refs }, apiFor(messages), context);
    const parent = runtimeResultArtifacts([
      entry(attached.details),
      entry({
        battyFileChanges: [
          { path: "a.ts", before: "local before\n", after: "local after\n", order: 1 },
        ],
      }),
    ]);
    expect(parent.fileChanges!.slice(0, 2)).toEqual([first, second]);
    expect(parent.sentFiles).toEqual([file]);
    expect(parent.fileChanges).toHaveLength(3);
    const chained = await tool.execute(
      { refs },
      apiFor([{ role: "toolResult", details: parent }]),
      context,
    );
    expect(chained).toEqual(attached);
    expect(
      await tool.execute({ refs }, apiFor([{ role: "toolResult", details: parent }]), context),
    ).toEqual(chained);
    const output = runtimeResultArtifacts([entry(chained.details)]);
    expect(output).toEqual(inventory);
    expect(artifactRefs(output).map((item) => item.ref)).toEqual(refs);
    // The importer is not involved: there is no source path, and the original
    // download URL and ID survive forwarding unchanged.
    expect(output.sentFiles![0]).toStrictEqual(file);
  },
);

test("local reverts never remove immutable same-path forwarded diffs", () => {
  const artifacts = runtimeResultArtifacts([
    entry({ forwardedArtifacts: inventory, ...inventory }),
    entry({ battyFileChanges: [{ path: "a.ts", before: "unchanged", after: "unchanged" }] }),
  ]);
  expect(artifacts.fileChanges).toEqual([first, second]);
  const next = runtimeResultArtifacts([entry(artifacts)]);
  expect(next.fileChanges).toEqual([first, second]);
});
