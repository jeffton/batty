import { describe, expect, it } from "vite-plus/test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { normalizeMessage } from "./pi-state";

describe("normalizeMessage", () => {
  it("strips terminal formatting from bash execution output", () => {
    const message = {
      role: "bashExecution",
      command: "vp test --run",
      output: "[1m [34mRUN [39m [90m/root/github/batty[39m\n\u001b[32m4 passed\u001b[39m",
      cancelled: false,
      truncated: false,
      timestamp: 1,
    } as unknown as AgentMessage;

    const normalized = normalizeMessage(message, 0);

    expect(normalized?.role).toBe("bashExecution");
    expect(normalized && "output" in normalized ? normalized.output : "").toBe(
      " RUN  /root/github/batty\n4 passed",
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

  it("preserves tool execution details for edit results", () => {
    const message = {
      role: "toolResult",
      toolCallId: "call-2",
      toolName: "edit",
      content: [{ type: "text", text: "Successfully replaced text in src/app.ts." }],
      details: {
        diff: " 1 const before = true;\n-2 const value = 1;\n+2 const value = 2;",
        firstChangedLine: 2,
      },
      isError: false,
      timestamp: 3,
    } as unknown as AgentMessage;

    const normalized = normalizeMessage(message, 0);

    expect(normalized?.role).toBe("toolResult");
    expect(normalized && "details" in normalized ? normalized.details : undefined).toEqual({
      diff: " 1 const before = true;\n-2 const value = 1;\n+2 const value = 2;",
      firstChangedLine: 2,
    });
  });
});
