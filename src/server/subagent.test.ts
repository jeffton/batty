import { describe, expect, it } from "vite-plus/test";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import {
  buildSubagentDetails,
  cloneMessagesForSubagent,
  extractAssistantText,
  findLastAssistantMessage,
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
        },
        messages,
        findLastAssistantMessage(messages),
      ),
    ).toEqual({
      subagent: {
        prompt: "Review the auth flow",
        model: "openai/gpt-5",
        effort: "high",
        includeSessionContext: true,
        messageCount: 1,
        stopReason: "stop",
        errorMessage: undefined,
      },
    });
  });
});
