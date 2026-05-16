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
        now: new Date("2026-04-19T08:58:37"),
      }),
    ).toEqual({
      kind: "cron",
      text: "Cron run triggered. Current time: 2026-04-19 08:58:37. Schedule: 0 9 * * 1-5\n\nPrompt:\nCheck CI",
    });
  });

  it("builds subagent notices", () => {
    expect(buildSubagentRuntimeNotice()).toEqual({
      kind: "subagent",
      text: "Subagent run started. Do not call the subagent tool from this session.",
    });
  });

  it("builds runtime notice messages", () => {
    const message = buildRuntimeNoticeMessage(
      buildCronRuntimeNotice({
        scheduleLabel: "every 1h",
        prompt: "Inspect workspace",
        now: new Date("2026-04-19T08:58:37"),
      }),
      42,
    ) as AgentMessage;

    expect(message).toMatchObject({
      role: "custom",
      customType: `${BATTY_RUNTIME_NOTICE_CUSTOM_TYPE}:cron`,
      content:
        "Cron run triggered. Current time: 2026-04-19 08:58:37. Schedule: every 1h\n\nPrompt:\nInspect workspace",
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
        message: buildRuntimeNoticeMessage(buildSubagentRuntimeNotice(), 2),
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
        content: "Subagent run started. Do not call the subagent tool from this session.",
        timestamp: 2,
      },
    ]);
  });
});
