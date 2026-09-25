import { describe, expect, it } from "vite-plus/test";
import {
  AGENT_TURN_FILE_CHANGES_CUSTOM_TYPE,
  agentTurnArtifactsByReplyEntryId,
  agentTurnFileChangesByReplyEntryId,
} from "./agent-turn-file-changes";

const message = (id: string, value: object) => ({ id, type: "message", message: value });
const mutation = (id: string, before: string | null, after: string) =>
  message(id, {
    role: "toolResult",
    details: {
      battyFileChanges: [{ path: "/work/file.txt", before, after, patch: "per-tool patch" }],
    },
  });
const reply = (id: string) =>
  message(id, { role: "assistant", content: [{ type: "text", text: "done" }] });

describe("durable file change projection", () => {
  it("aggregates repeated writes and subagent results into one final per-file diff", () => {
    const entries = [
      message("user", { role: "user" }),
      mutation("write", "before\n", "intermediate\n"),
      mutation("subagent", "intermediate\n", "after\n"),
      reply("reply"),
    ];
    const original = JSON.stringify(entries);
    const changes = agentTurnFileChangesByReplyEntryId(entries).get("reply")!;
    expect(changes).toHaveLength(1);
    expect(changes[0]!.patch).toContain("-before");
    expect(changes[0]!.patch).toContain("+after");
    expect(changes[0]!.patch).not.toContain("intermediate");
    expect(JSON.stringify(entries)).toBe(original);
  });

  it("omits net-zero changes and resets at the durable reply", () => {
    const entries = [
      mutation("first", "before", "after"),
      mutation("revert", "after", "before"),
      reply("reply"),
      message("user", { role: "user" }),
      reply("next"),
    ];
    const changes = agentTurnFileChangesByReplyEntryId(entries);
    expect(changes.get("reply")).toEqual([]);
    expect(changes.has("next")).toBe(false);
  });

  it("keeps changes across steering user entries and isolates later replies", () => {
    const changes = agentTurnFileChangesByReplyEntryId([
      mutation("first", "before\n", "middle\n"),
      message("steer", { role: "user" }),
      mutation("second", "middle\n", "after\n"),
      reply("first-reply"),
      message("follow-up", { role: "user" }),
      mutation("third", "after\n", "last\n"),
      reply("second-reply"),
      message("next-user", { role: "user" }),
      reply("empty-reply"),
    ]);
    expect(changes.get("first-reply")?.[0]?.patch).toContain("-before");
    expect(changes.get("first-reply")?.[0]?.patch).toContain("+after");
    expect(changes.get("second-reply")?.[0]?.patch).toContain("-after");
    expect(changes.get("second-reply")?.[0]?.patch).toContain("+last");
    expect(changes.has("empty-reply")).toBe(false);
  });

  it("retains mutations across a retry response and subsequent steering", () => {
    const changes = agentTurnFileChangesByReplyEntryId([
      mutation("first", "before\n", "middle\n"),
      message("failed-attempt", { role: "assistant", content: [], stopReason: "error" }),
      message("retry-call", { role: "assistant", content: [{ type: "toolCall", name: "edit" }] }),
      mutation("retry-result", "middle\n", "after\n"),
      message("steer", { role: "user" }),
      reply("final-reply"),
    ]);
    expect(changes.get("final-reply")?.[0]?.patch).toContain("-before");
    expect(changes.get("final-reply")?.[0]?.patch).toContain("+after");
  });

  it("attaches changes to terminal replies instead of tool-call messages", () => {
    const entries = [
      mutation("write", null, "new file\n"),
      message("call", { role: "assistant", content: [{ type: "toolCall", name: "read" }] }),
      reply("reply"),
    ];
    const changes = agentTurnFileChangesByReplyEntryId(entries);
    expect(changes.has("call")).toBe(false);
    expect(changes.get("reply")?.[0]?.patch).toContain("+new file");
  });

  it("isolates cron replies from copied context and preceding inline turns", () => {
    const cronPrompt = (id: string) =>
      message(id, {
        role: "custom",
        customType: "batty-runtime-notice:cron",
        data: { cron: { runId: id } },
      });
    const changes = agentTurnFileChangesByReplyEntryId([
      mutation("parent-write", "before\n", "parent\n"),
      reply("parent-reply"),
      cronPrompt("read-only-cron"),
      reply("read-only-reply"),
      cronPrompt("editing-cron"),
      mutation("cron-write", "parent\n", "child\n"),
      reply("cron-reply"),
      cronPrompt("next-cron"),
      reply("next-reply"),
    ]);
    expect(changes.get("parent-reply")?.[0]?.patch).toContain("-before");
    expect(changes.has("read-only-reply")).toBe(false);
    expect(changes.get("cron-reply")?.[0]?.patch).toContain("-parent");
    expect(changes.get("cron-reply")?.[0]?.patch).toContain("+child");
    expect(changes.has("next-reply")).toBe(false);
  });

  it("isolates delivered cron diffs from parent turns and other deliveries", () => {
    const files = [{ path: "/cron/file.txt", patch: "child diff" }];
    const delivered = (id: string, fileChanges?: typeof files) =>
      message(id, {
        role: "assistant",
        content: [{ type: "text", text: "cron result" }],
        ...(fileChanges ? { battyDeliveredFileChanges: fileChanges } : {}),
      });
    const changes = agentTurnFileChangesByReplyEntryId([
      mutation("parent-write", "before\n", "after\n"),
      reply("parent-reply"),
      message("notice", {
        role: "custom",
        customType: "batty-runtime-notice:cron",
        data: { cron: { sessionPath: "/cron/child.jsonl" } },
      }),
      message("child-files", {
        role: "toolResult",
        toolCallId: "cron-files:child",
        details: {
          battyFileChanges: [{ path: "/cron/leak", before: null, after: "leak" }],
          sentFiles: [{ id: "file-1", name: "report.md" }],
        },
      }),
      message("child-sites", {
        role: "toolResult",
        toolCallId: "cron-sites:child",
        details: { sites: [{ id: "site-1", name: "Report" }] },
      }),
      delivered("child", files),
      message("empty-notice", {
        role: "custom",
        customType: "batty-runtime-notice:cron",
        data: { cron: { sessionPath: "/cron/empty.jsonl" } },
      }),
      delivered("empty-child", []),
      message("error-notice", {
        role: "custom",
        customType: "batty-runtime-notice:cron",
        data: { cron: { jobId: "skipped-job", runId: "skipped-run" } },
      }),
      delivered("error-or-historical-child"),
      message("next-user", { role: "user" }),
      reply("next-reply"),
    ]);
    expect(changes.get("parent-reply")?.[0]?.patch).toContain("+after");
    expect(changes.get("child")).toEqual(files);
    const artifacts = agentTurnArtifactsByReplyEntryId([
      message("notice", {
        role: "custom",
        customType: "batty-runtime-notice:cron",
        data: { cron: { sessionPath: "/cron/child.jsonl" } },
      }),
      message("file", {
        role: "toolResult",
        toolCallId: "cron-files:child",
        details: { sentFiles: [{ id: "file-1", name: "report.md" }] },
      }),
      message("site", {
        role: "toolResult",
        toolCallId: "cron-sites:child",
        details: { sites: [{ id: "site-1", name: "Report" }] },
      }),
      delivered("child", files),
      reply("next-reply"),
    ]);
    expect(artifacts.get("child")?.sentFiles?.[0]?.id).toBe("file-1");
    expect(artifacts.get("child")?.sites?.[0]?.id).toBe("site-1");
    expect(artifacts.get("next-reply")?.sentFiles).toBeUndefined();
    expect(changes.get("empty-child")).toEqual([]);
    expect(changes.has("error-or-historical-child")).toBe(false);
    expect(changes.has("next-reply")).toBe(false);
  });

  it("projects async subagent artifacts onto the parent reply", () => {
    const sentFile = {
      id: "file-1",
      name: "report.md",
      size: 10,
      mimeType: "text/markdown",
      kind: "file" as const,
      downloadUrl: "/report.md",
    };
    const site = { id: "site-1", name: "Report", url: "/sites/site-1", public: false };
    const artifacts = agentTurnArtifactsByReplyEntryId([
      mutation("old-write", "old\n", "stale\n"),
      reply("old-reply"),
      message("async-child", {
        role: "custom",
        customType: "batty-runtime-notice:subagent",
        data: {
          subagent: { sessionId: "child" },
          battyFileChanges: [
            {
              path: "/work/child.txt",
              before: "before\n",
              after: "after\n",
              patch: "per-tool patch",
            },
          ],
          sentFiles: [sentFile],
          sites: [site],
        },
      }),
      reply("parent-reply"),
    ]).get("parent-reply");

    expect(artifacts?.fileChanges?.[0]?.patch).toContain("-before");
    expect(artifacts?.fileChanges?.[0]?.patch).toContain("+after");
    expect(artifacts?.fileChanges?.[0]?.patch).not.toContain("stale");
    expect(artifacts?.sentFiles).toEqual([sentFile]);
    expect(artifacts?.sites).toEqual([site]);
  });

  it("does not let a background delivery consume pending parent edits", () => {
    const changes = agentTurnFileChangesByReplyEntryId([
      mutation("parent-write", "before\n", "middle\n"),
      message("notice", {
        role: "custom",
        customType: "batty-runtime-notice:cron",
        data: { cron: { sessionPath: "/cron/child.jsonl" } },
      }),
      message("child", {
        role: "assistant",
        content: [{ type: "text", text: "cron result" }],
        battyDeliveredFileChanges: [],
      }),
      message("steer", { role: "user" }),
      mutation("parent-write-again", "middle\n", "after\n"),
      reply("parent-reply"),
    ]);
    expect(changes.get("parent-reply")?.[0]?.patch).toContain("-before");
    expect(changes.get("parent-reply")?.[0]?.patch).toContain("+after");
  });

  it("preserves imported historical per-turn metadata", () => {
    const files = [{ path: "/file", patch: "historical diff" }];
    expect(
      agentTurnFileChangesByReplyEntryId([
        {
          type: "custom",
          customType: AGENT_TURN_FILE_CHANGES_CUSTOM_TYPE,
          data: { version: 1, replyEntryId: "reply", files },
        },
      ]).get("reply"),
    ).toEqual(files);
  });
});
