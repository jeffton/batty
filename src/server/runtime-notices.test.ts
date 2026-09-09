import { describe, expect, it } from "vite-plus/test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  BATTY_RUNTIME_NOTICE_CUSTOM_TYPE,
  buildCronRuntimeNotice,
  buildRuntimeNoticeMessage,
  buildSubagentRuntimeNotice,
} from "./runtime-notices";
import { transcriptMessagesFromSessionEntries } from "./pi-state";

type AgentMessage = AgentSession["messages"][number];

describe("runtime notices", () => {
  it("builds cron notices", () => {
    expect(
      buildCronRuntimeNotice({
        scheduleLabel: "0 9 * * 1-5",
        prompt: "Check CI",
        session: { kind: "new" },
        now: new Date("2026-04-19T08:58:37"),
      }),
    ).toEqual({
      kind: "cron",
      text: expect.stringMatching(
        /^Cron run triggered\. Current time: 2026-04-19 08:58:37\. Schedule: 0 9 \* \* 1-5\n\nSession mode: new\.[\s\S]*\n\nPrompt:\nCheck CI$/,
      ),
    });
  });

  it.each([false, true, undefined])(
    "explains detached context with includePreviousContext=%s",
    (includePreviousContext) => {
      const { text } = buildCronRuntimeNotice({
        scheduleLabel: "every 1h",
        prompt: "Research",
        session: { kind: "daily-detached", includePreviousContext },
      });
      expect(text).toContain("Each run gets a separate session");
      expect(text).toContain(
        includePreviousContext ? "fixed snapshot of the daily context" : "You start fresh",
      );
      expect(text).not.toContain(
        includePreviousContext ? "You start fresh" : "You have a fixed snapshot",
      );
      expect(text).toContain("Detailed work and tool calls stay here");
      expect(text).toContain("your final response or an error returns");
      expect(text).toContain("NO_REPLY for a silent successful run");
      expect(text).toContain("This isolation protects daily context");
    },
  );

  it.each(["delivery", "skipped"] as const)(
    "distinguishes %s notices from execution instructions",
    (phase) => {
      const { text } = buildCronRuntimeNotice({
        scheduleLabel: "every 1h",
        prompt: "Research",
        session: { kind: "daily-detached", includePreviousContext: true },
        phase,
      });
      expect(text).toContain(phase === "delivery" ? "Detached cron result." : "run was skipped.");
      expect(text).toContain("Scheduled prompt (for reference):\nResearch");
      expect(text).not.toContain("You have a fixed snapshot");
      expect(text).not.toContain("Cron run triggered");
    },
  );

  it("builds subagent notices for the permitted child depth", () => {
    expect(buildSubagentRuntimeNotice(1, "  Child work  ")).toEqual({
      kind: "subagent",
      text: "Subagent run started. You can delegate to subagents, but subagents you create cannot delegate further.\n\nPrompt:\nChild work",
    });
  });

  it("builds subagent notices for the maximum depth", () => {
    expect(buildSubagentRuntimeNotice(2, "Nested work")).toEqual({
      kind: "subagent",
      text: "Subagent run started. Do not call the subagent tool from this session.\n\nPrompt:\nNested work",
    });
  });

  it("builds runtime notice messages", () => {
    const message = buildRuntimeNoticeMessage(
      buildCronRuntimeNotice({
        scheduleLabel: "every 1h",
        prompt: "Inspect workspace",
        session: { kind: "daily-inline" },
        now: new Date("2026-04-19T08:58:37"),
      }),
      42,
    ) as AgentMessage;

    expect(message).toMatchObject({
      role: "custom",
      customType: `${BATTY_RUNTIME_NOTICE_CUSTOM_TYPE}:cron`,
      content: expect.stringContaining("Session mode: daily-inline."),
      timestamp: 42,
    });
  });

  it("includes visible custom-message runtime notices in transcript pagination", () => {
    const messages = transcriptMessagesFromSessionEntries([
      {
        type: "custom_message",
        customType: `${BATTY_RUNTIME_NOTICE_CUSTOM_TYPE}:cron`,
        content: "Cron run triggered.",
        timestamp: "2026-05-16T10:30:00.904Z",
      },
    ] as Array<{
      type?: unknown;
      customType?: unknown;
      content?: unknown;
      timestamp?: unknown;
    }>);

    expect(messages).toEqual([
      {
        role: "custom",
        customType: `${BATTY_RUNTIME_NOTICE_CUSTOM_TYPE}:cron`,
        content: "Cron run triggered.",
        timestamp: Date.parse("2026-05-16T10:30:00.904Z"),
      },
    ]);
  });

  it("includes visible runtime notice messages in transcript pagination", () => {
    const messages = transcriptMessagesFromSessionEntries([
      {
        type: "message",
        message: {
          role: "user",
          content: "hello",
          timestamp: 1,
        },
      },
      {
        type: "message",
        message: buildRuntimeNoticeMessage(buildSubagentRuntimeNotice(2, "Nested work"), 2),
      },
      {
        type: "custom",
        customType: "batty-system-prompt",
        data: { nope: true },
      },
    ] as Array<{ type?: unknown; message?: unknown; customType?: unknown; data?: unknown }>);

    expect(messages).toEqual([
      {
        role: "user",
        content: "hello",
        timestamp: 1,
      },
      {
        role: "custom",
        customType: `${BATTY_RUNTIME_NOTICE_CUSTOM_TYPE}:subagent`,
        content:
          "Subagent run started. Do not call the subagent tool from this session.\n\nPrompt:\nNested work",
        timestamp: 2,
      },
    ]);
  });
});
