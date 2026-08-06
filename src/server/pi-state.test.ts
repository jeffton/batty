import { describe, expect, it } from "vite-plus/test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createSessionState, normalizeMessage } from "./pi-state";

type AgentMessage = AgentSession["messages"][number];

describe("createSessionState", () => {
  it("uses stable global message indexes for paginated windows", () => {
    const state = createSessionState({
      id: "web-1",
      sessionId: "session-1",
      workspaceId: "batty",
      cwd: "/tmp/batty",
      thinkingLevel: "medium",
      availableThinkingLevels: ["medium"],
      isStreaming: false,
      pendingMessageCount: 0,
      updatedAt: 2,
      contextTokens: null,
      contextWindow: null,
      contextPercent: null,
      totalMessageCount: 3,
      hasMoreMessages: true,
      messageIndexOffset: 1,
      messages: [
        {
          role: "assistant",
          content: "middle",
          timestamp: 2,
        },
        {
          role: "assistant",
          content: "latest",
          timestamp: 3,
        },
      ] as unknown as AgentMessage[],
      activeTools: [],
      title: undefined,
    });

    expect(state.messages.map((message) => message.id)).toEqual(["assistant-2-1", "assistant-3-2"]);
  });
});

describe("normalizeMessage", () => {
  it("preserves client message IDs on user messages", () => {
    const normalized = normalizeMessage(
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: 1,
        clientMessageId: "client-message-1",
      } as unknown as AgentMessage,
      0,
    );

    expect(normalized).toMatchObject({
      role: "user",
      clientMessageId: "client-message-1",
    });
  });

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

  it("projects inline tool images as URLs without sending base64 data", () => {
    const imageData = Buffer.from("large screenshot").toString("base64");
    const message = {
      role: "toolResult",
      toolCallId: "call-image",
      toolName: "read",
      content: [{ type: "image", mimeType: "image/png", data: imageData }],
      isError: false,
      timestamp: 3,
    } as unknown as AgentMessage;

    const normalized = normalizeMessage(message, 0, {
      imageResolver: () => ({ url: "/api/uploads/session/imported/image.png" }),
    });

    expect(normalized && "blocks" in normalized ? normalized.blocks : undefined).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        data: undefined,
        url: "/api/uploads/session/imported/image.png",
        name: undefined,
      },
    ]);
    expect(JSON.stringify(normalized)).not.toContain(imageData);
    expect(JSON.stringify(message)).toContain(imageData);
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
