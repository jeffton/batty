import { describe, expect, it } from "vite-plus/test";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import {
  BATTY_RUNTIME_NOTICE_CUSTOM_TYPE,
  buildCronRuntimeNotice,
  buildRuntimeNoticeEntryData,
  buildSubagentRuntimeNotice,
  runtimeNoticeMessageFromEntry,
} from "./runtime-notices";
import { transcriptMessagesFromSessionEntries } from "./pi-state";

type AgentMessage = AgentSession["messages"][number];

describe("runtime notices", () => {
  it("builds cron notices for the system prompt and transcript", () => {
    expect(buildCronRuntimeNotice("0 9 * * 1-5", new Date("2026-03-20T12:34:56Z"))).toEqual({
      kind: "cron",
      text: "Cron run triggered. Schedule: 0 9 * * 1-5",
      systemPrompt: [
        "[Batty cron turn]",
        "This turn was triggered by a Batty cron job.",
        "Schedule: 0 9 * * 1-5",
        "Current local date and time: 2026-03-20 13:34:56 (Friday)",
      ].join("\n"),
    });
  });

  it("builds subagent notices for the system prompt and transcript", () => {
    expect(buildSubagentRuntimeNotice()).toEqual({
      kind: "subagent",
      text: "Subagent run started. Do not call the subagent tool from this session.",
      systemPrompt: [
        "[Batty subagent turn]",
        "You are running inside a Batty subagent.",
        "Do not call the subagent tool from this session.",
      ].join("\n"),
    });
  });

  it("converts persisted runtime notices into transcript messages", () => {
    const message = runtimeNoticeMessageFromEntry({
      type: "custom",
      customType: BATTY_RUNTIME_NOTICE_CUSTOM_TYPE,
      data: buildRuntimeNoticeEntryData(buildCronRuntimeNotice("every 1h"), 42),
    }) as AgentMessage;

    expect(message).toMatchObject({
      role: "custom",
      customType: `${BATTY_RUNTIME_NOTICE_CUSTOM_TYPE}:cron`,
      content: "Cron run triggered. Schedule: every 1h",
      timestamp: 42,
    });
  });

  it("includes visible runtime notices in transcript pagination without replaying hidden custom entries", () => {
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
        type: "custom",
        customType: BATTY_RUNTIME_NOTICE_CUSTOM_TYPE,
        data: buildRuntimeNoticeEntryData(buildSubagentRuntimeNotice(), 2),
      },
      {
        type: "custom",
        customType: "batty-system-prompt",
        data: { nope: true },
      },
    ]);

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
