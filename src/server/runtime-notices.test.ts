import { describe, expect, it } from "vite-plus/test";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
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
    expect(buildCronRuntimeNotice("0 9 * * 1-5")).toEqual({
      kind: "cron",
      text: "Cron run triggered. Schedule: 0 9 * * 1-5",
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
      buildCronRuntimeNotice("every 1h"),
      42,
    ) as AgentMessage;

    expect(message).toMatchObject({
      role: "custom",
      customType: `${BATTY_RUNTIME_NOTICE_CUSTOM_TYPE}:cron`,
      content: "Cron run triggered. Schedule: every 1h",
      timestamp: 42,
    });
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
