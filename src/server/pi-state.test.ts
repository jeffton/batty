import { describe, expect, it } from "vite-plus/test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  createSessionState,
  normalizeMessage,
  transcriptMessagesFromSessionEntries,
} from "./pi-state";

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

  it("omits tool calls and results from summary message payloads", () => {
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
      totalMessageCount: 2,
      hasMoreMessages: false,
      messagesDetailLevel: "summary",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking it." },
            { type: "toolCall", id: "call-1", name: "read", arguments: { path: "large" } },
          ],
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "large result" }],
          details: { diff: "large diff" },
          isError: false,
          timestamp: 2,
        },
      ] as unknown as AgentMessage[],
      activeTools: [],
    });

    expect(state.messagesDetailLevel).toBe("summary");
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      role: "assistant",
      blocks: [{ type: "text", text: "Checking it." }],
    });
    expect(JSON.stringify(state)).not.toContain("large result");
    expect(JSON.stringify(state)).not.toContain("large diff");
  });

  it.each(["summary", "full"] as const)(
    "does not expose a persisted tool-call assistant as active in %s state",
    (messagesDetailLevel) => {
      const persistedAssistant = {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Inspecting the project." },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
        ],
        timestamp: 1,
      } as unknown as AgentMessage;
      const state = createSessionState({
        id: "web-1",
        sessionId: "session-1",
        workspaceId: "batty",
        cwd: "/tmp/batty",
        thinkingLevel: "medium",
        availableThinkingLevels: ["medium"],
        isStreaming: true,
        pendingMessageCount: 0,
        updatedAt: 2,
        contextTokens: null,
        contextWindow: null,
        contextPercent: null,
        totalMessageCount: 1,
        hasMoreMessages: false,
        messagesDetailLevel,
        messages: [persistedAssistant],
        activeAssistant: persistedAssistant,
        activeTools: [],
      });

      expect(state.messages).toHaveLength(1);
      expect(state.activeAssistant).toBeUndefined();
      expect(state.messages[0]).toMatchObject({
        role: "assistant",
        blocks: [
          { type: "thinking", thinking: "Inspecting the project." },
          { type: "toolCall", id: "call-1" },
        ],
      });
    },
  );

  it("keeps a different tool-call assistant active", () => {
    const state = createSessionState({
      id: "web-1",
      sessionId: "session-1",
      workspaceId: "batty",
      cwd: "/tmp/batty",
      thinkingLevel: "medium",
      availableThinkingLevels: ["medium"],
      isStreaming: true,
      pendingMessageCount: 0,
      updatedAt: 2,
      contextTokens: null,
      contextWindow: null,
      contextPercent: null,
      totalMessageCount: 1,
      hasMoreMessages: false,
      messagesDetailLevel: "summary",
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
          timestamp: 1,
        },
      ] as unknown as AgentMessage[],
      activeAssistant: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-2", name: "read", arguments: {} }],
        timestamp: 1,
      } as unknown as AgentMessage,
      activeTools: [],
    });

    expect(state.messages[0]).toMatchObject({ role: "assistant", blocks: [] });
    expect(state.activeAssistant?.blocks).toMatchObject([{ type: "toolCall", id: "call-2" }]);
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

  it("hides uploaded file XML and lists non-image attachments", () => {
    const normalized = normalizeMessage(
      {
        role: "user",
        content: [
          {
            type: "text",
            text: 'Review this\n\n<file name="notes &amp; data.txt" mimeType="text/plain" size="42" path="/tmp/notes.txt" url="/api/uploads/session/batch/notes.txt"></file>',
          },
        ],
        timestamp: 1,
      } as unknown as AgentMessage,
      0,
    );

    expect(normalized && "blocks" in normalized ? normalized.blocks : undefined).toEqual([
      { type: "text", text: "Review this" },
      {
        type: "attachment",
        file: {
          id: "/api/uploads/session/batch/notes.txt",
          name: "notes & data.txt",
          size: 42,
          mimeType: "text/plain",
          kind: "file",
          downloadUrl: "/api/uploads/session/batch/notes.txt",
        },
      },
    ]);
    expect(JSON.stringify(normalized)).not.toContain("<file");
  });

  it("hides uploaded image XML while retaining the rendered image", () => {
    const normalized = normalizeMessage(
      {
        role: "user",
        content: [
          {
            type: "text",
            text: '<file name="photo.png" mimeType="image/png" size="123" path="/tmp/photo.png" url="/api/uploads/session/batch/photo.png"></file>',
          },
        ],
        timestamp: 1,
        battyAttachments: [
          {
            kind: "image",
            name: "photo.png",
            mimeType: "image/png",
            size: 123,
            url: "/api/uploads/session/batch/photo.png",
          },
        ],
      } as unknown as AgentMessage,
      0,
    );

    expect(normalized && "blocks" in normalized ? normalized.blocks : undefined).toEqual([
      {
        type: "image",
        name: "photo.png",
        mimeType: "image/png",
        url: "/api/uploads/session/batch/photo.png",
      },
    ]);
    expect(JSON.stringify(normalized)).not.toContain("<file");
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

  it.each(["bash", "powershell"])("strips terminal formatting from %s tool results", (toolName) => {
    const message = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName,
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

describe("transcriptMessagesFromSessionEntries", () => {
  it("associates persisted file changes with their assistant reply", () => {
    const messages = transcriptMessagesFromSessionEntries(
      [
        {
          type: "message",
          id: "reply-1",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done" }],
            timestamp: 1,
          },
        },
      ],
      [
        {
          type: "custom",
          customType: "batty-agent-turn-file-changes",
          data: {
            version: 1,
            replyEntryId: "reply-1",
            files: [{ path: "/repo/a.ts", patch: "patch" }],
          },
        },
      ],
    );

    const normalized = normalizeMessage(messages[0]!, 0);
    expect(normalized?.role === "assistant" ? normalized.fileChanges : undefined).toEqual([
      { path: "/repo/a.ts", patch: "patch" },
    ]);
  });
});
