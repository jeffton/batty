import { describe, expect, it, vi } from "vite-plus/test";
import { createSubagentTool } from "./pi-service-tools";

describe("createSubagentTool", () => {
  function createContext() {
    return {
      sessionManager: {
        getEntries: () => [],
        getSessionId: () => "parent-session",
      },
    } as any;
  }

  it("returns a normal tool result after a successful detached subagent run", async () => {
    const runDetachedSubagentSession = vi.fn(async () => ({
      text: "done",
      details: {
        subagent: {
          prompt: "Inspect",
          model: "openai/gpt-5",
          effort: "medium",
          includeSessionContext: false,
          respondIn: "tool-call",
          messageCount: 1,
        },
      },
      isError: false,
    }));
    const tool = createSubagentTool({
      workspace: { id: "batty", path: "/root/github/batty" } as any,
      config: {} as any,
      resolveSubagentDefaults: () => ({ modelId: "openai/gpt-5", thinkingLevel: "medium" }),
      runSubagentSerial: async (_sessionId, run) => run(),
      runDetachedSubagentSession,
    });

    const result = await tool.execute(
      "tool-call-1",
      { prompt: "Inspect" },
      undefined,
      undefined,
      createContext(),
    );

    expect(runDetachedSubagentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: "parent-session",
        prompt: "Inspect",
        modelId: "openai/gpt-5",
        thinkingLevel: "medium",
        includeSessionContext: false,
        respondIn: "tool-call",
        currentToolCallId: "tool-call-1",
      }),
    );
    expect(result).toMatchObject({
      content: [{ type: "text", text: "done" }],
      isError: false,
    });
    expect(result).not.toHaveProperty("terminate");
  });

  it("returns a normal tool error result after a failed detached subagent run", async () => {
    const tool = createSubagentTool({
      workspace: { id: "batty", path: "/root/github/batty" } as any,
      config: {} as any,
      resolveSubagentDefaults: () => ({ modelId: "openai/gpt-5", thinkingLevel: "medium" }),
      runSubagentSerial: async (_sessionId, run) => run(),
      runDetachedSubagentSession: async () => ({
        text: "subagent failed",
        details: {
          subagent: {
            prompt: "Inspect",
            model: "openai/gpt-5",
            effort: "medium",
            includeSessionContext: false,
            respondIn: "tool-call",
            messageCount: 1,
            errorMessage: "subagent failed",
          },
        },
        isError: true,
      }),
    });

    const result = await tool.execute(
      "tool-call-2",
      { prompt: "Inspect" },
      undefined,
      undefined,
      createContext(),
    );

    expect(result).toMatchObject({
      content: [{ type: "text", text: "subagent failed" }],
      isError: true,
    });
    expect(result).not.toHaveProperty("terminate");
  });
});
