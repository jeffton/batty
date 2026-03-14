import { describe, expect, it } from "vite-plus/test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { normalizeMessage } from "./pi-state";

describe("normalizeMessage", () => {
  it("strips terminal formatting from bash execution output", () => {
    const message = {
      role: "bashExecution",
      command: "vp test --run",
      output: "[1m [34mRUN [39m [90m/root/github/pi-face[39m\n\u001b[32m4 passed\u001b[39m",
      cancelled: false,
      truncated: false,
      timestamp: 1,
    } as unknown as AgentMessage;

    const normalized = normalizeMessage(message, 0);

    expect(normalized?.role).toBe("bashExecution");
    expect(normalized && "output" in normalized ? normalized.output : "").toBe(
      " RUN  /root/github/pi-face\n4 passed",
    );
  });

  it("strips terminal formatting from bash tool results", () => {
    const message = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "[1m[94mpass:[39m all good" }],
      isError: false,
      timestamp: 2,
    } as unknown as AgentMessage;

    const normalized = normalizeMessage(message, 0);

    expect(normalized?.role).toBe("toolResult");
    expect(normalized && "blocks" in normalized ? normalized.blocks[0] : undefined).toEqual({
      type: "text",
      text: "pass: all good",
    });
  });
});
