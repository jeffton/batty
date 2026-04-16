import { describe, expect, it } from "vite-plus/test";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
  buildSubagentDetails,
  cloneMessagesForSubagent,
  collectSentFiles,
  extractAssistantText,
  findLastAssistantMessage,
  newlyGeneratedSubagentMessages,
  stripThinkingFromAssistantMessage,
  hasSubagentSessionMarker,
  SUBAGENT_SESSION_CUSTOM_TYPE,
} from "./subagent";

type AgentMessage = AgentSession["messages"][number];

describe("cloneMessagesForSubagent", () => {
  it("drops the current assistant tool-call message from inherited context", () => {
    const messages = [
      {
        role: "user",
        content: "Delegate this",
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Working on it." },
          {
            type: "toolCall",
            id: "sub-1",
            name: "subagent",
            arguments: { prompt: "Investigate bug" },
          },
        ],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 2,
      },
    ] as unknown as AgentMessage[];

    expect(cloneMessagesForSubagent(messages, "sub-1")).toEqual([messages[0]]);
  });

  it("keeps prior messages when the trailing assistant message is unrelated", () => {
    const messages = [
      {
        role: "user",
        content: "hello",
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
    ] as unknown as AgentMessage[];

    expect(cloneMessagesForSubagent(messages, "sub-1")).toEqual(messages);
  });
});

describe("subagent session markers", () => {
  it("detects persisted subagent sessions", () => {
    expect(
      hasSubagentSessionMarker([
        { type: "custom", customType: SUBAGENT_SESSION_CUSTOM_TYPE },
        { type: "custom", customType: "other" },
      ]),
    ).toBe(true);
    expect(hasSubagentSessionMarker([{ type: "custom", customType: "other" }])).toBe(false);
  });
});

describe("stripThinkingFromAssistantMessage", () => {
  it("removes thinking blocks and keeps visible assistant output", () => {
    const message: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "internal" },
        { type: "text", text: "NO_REPLY" },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    } as const;

    expect(stripThinkingFromAssistantMessage(message)).toMatchObject({
      content: [{ type: "text", text: "NO_REPLY" }],
    });
  });
});

describe("subagent message helpers", () => {
  it("extracts assistant text and final assistant metadata", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "First" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Final answer" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5",
        usage: {
          input: 2,
          output: 3,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 5,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
    ] as unknown as AgentMessage[];

    const finalAssistant = findLastAssistantMessage(messages);
    expect(extractAssistantText(finalAssistant)).toBe("Final answer");
    expect(finalAssistant?.model).toBe("gpt-5");
  });

  it("builds persisted subagent details", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "Delegated" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      },
    ] as unknown as AgentMessage[];

    expect(
      buildSubagentDetails(
        {
          prompt: "Review the auth flow",
          model: "openai/gpt-5",
          effort: "high",
          includeSessionContext: true,
          respondIn: "tool-call",
        },
        messages,
        findLastAssistantMessage(messages),
        {
          sessionId: "sub-123",
          sessionPath: "/tmp/sub-123.jsonl",
        },
      ),
    ).toEqual({
      subagent: {
        prompt: "Review the auth flow",
        model: "openai/gpt-5",
        effort: "high",
        includeSessionContext: true,
        respondIn: "tool-call",
        messageCount: 1,
        sessionId: "sub-123",
        sessionPath: "/tmp/sub-123.jsonl",
        stopReason: "stop",
        errorMessage: undefined,
      },
    });
  });

  it("collects sent files from nested tool results and keeps generated messages", () => {
    const messages = [
      {
        role: "user",
        content: "seed",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "attach-1",
        toolName: "attach-files",
        content: [{ type: "text", text: "Attached 1 file for the user." }],
        details: {
          sentFiles: [
            {
              id: "file-1",
              name: "report.txt",
              size: 7,
              mimeType: "text/plain",
              kind: "file",
              downloadUrl: "/api/sent-files/workspace/session/tool/file-1?download=1",
            },
          ],
        },
        isError: false,
        timestamp: 2,
      },
    ] as unknown as AgentMessage[];

    expect(collectSentFiles(messages)).toEqual([
      {
        id: "file-1",
        name: "report.txt",
        size: 7,
        mimeType: "text/plain",
        kind: "file",
        downloadUrl: "/api/sent-files/workspace/session/tool/file-1?download=1",
      },
    ]);
    expect(newlyGeneratedSubagentMessages(messages, 1)).toEqual([messages[1]]);
  });

  it("only propagates attachments from newly generated subagent messages", () => {
    const inherited = {
      role: "toolResult",
      toolCallId: "attach-old",
      toolName: "attach-files",
      content: [{ type: "text", text: "Attached 1 file for the user." }],
      details: {
        sentFiles: [
          {
            id: "old-file",
            name: "old.png",
            size: 10,
            mimeType: "image/png",
            kind: "image",
            downloadUrl: "/api/sent-files/workspace/session/tool/old-file?download=1",
            previewUrl: "/api/sent-files/workspace/session/tool/old-file",
          },
        ],
      },
      isError: false,
      timestamp: 1,
    };
    const generated = {
      role: "toolResult",
      toolCallId: "attach-new",
      toolName: "attach-files",
      content: [{ type: "text", text: "Attached 1 file for the user." }],
      details: {
        sentFiles: [
          {
            id: "new-file",
            name: "new.png",
            size: 11,
            mimeType: "image/png",
            kind: "image",
            downloadUrl: "/api/sent-files/workspace/session/tool/new-file?download=1",
            previewUrl: "/api/sent-files/workspace/session/tool/new-file",
          },
        ],
      },
      isError: false,
      timestamp: 2,
    };
    const messages = [inherited, generated] as unknown as AgentMessage[];

    expect(
      buildSubagentDetails(
        {
          prompt: "Attach the latest image",
          model: "openai/gpt-5",
          effort: "medium",
          includeSessionContext: true,
          respondIn: "session",
        },
        messages,
        undefined,
        { sentFileMessages: [generated as unknown as AgentMessage] },
      ),
    ).toMatchObject({
      sentFiles: [
        {
          id: "new-file",
          name: "new.png",
        },
      ],
    });
  });
});
