import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vite-plus/test";
import { createCronTool, createSubagentTool, spillToolOutputToTempFile } from "./pi-service-tools";

describe("spillToolOutputToTempFile", () => {
  it("stores oversized output in a temp file and returns a truncated head", async () => {
    const fullText = Array.from({ length: 2_010 }, (_, index) => `line ${index + 1}`).join("\n");

    const result = await spillToolOutputToTempFile(
      "web-search-output",
      "tool/call:1",
      {
        text: fullText,
        details: {
          action: "content",
          content: fullText,
          results: [{ title: "Result", content: fullText }],
        },
      },
      "web-search",
    );

    expect(result.text).toContain("Showing the first 2000 lines");
    expect(result.text).toContain("Full output saved to: ");
    expect(result.text).toContain("Use the read tool on that path if you need more.");
    expect(result.text).toContain("line 1\n");
    expect(result.text).toContain("line 2000");
    expect(result.text).not.toContain("line 2001");
    expect(result.details.truncated).toBe(true);
    expect(result.details.fullOutputPath).toEqual(expect.stringMatching(/tool-call-1\.txt$/));
    expect(result.details.content).toBeUndefined();
    expect(result.details.results).toEqual([{ title: "Result" }]);
    await expect(fs.readFile(String(result.details.fullOutputPath), "utf8")).resolves.toBe(
      fullText,
    );
  });

  it("uses UI line-ending semantics for head truncation", async () => {
    const fullText = Array.from({ length: 2_010 }, (_, index) => `line ${index + 1}`).join("\r");

    const result = await spillToolOutputToTempFile(
      "web-search-output",
      "carriage-returns",
      { text: fullText, details: {} },
      "web-search",
    );

    expect(result.text).toContain("Showing the first 2000 lines");
    expect(result.text).toContain("line 1\nline 2");
    expect(result.text).not.toContain("line 2001");
  });

  it("respects tail truncation and UTF-8 character boundaries", async () => {
    const fullText = `first\n${"🦇".repeat(13_000)}\nlast`;

    const result = await spillToolOutputToTempFile(
      "tool-output",
      "tail",
      { text: fullText, details: {} },
      "write",
    );

    expect(result.text).toContain("Showing the last");
    expect(result.text).not.toContain("�");
    expect(result.text).not.toContain("first");
    expect(result.text).toContain("last");
  });

  it("respects head truncation and UTF-8 character boundaries", async () => {
    const fullText = `first\n${"🦇".repeat(13_000)}\nlast`;

    const result = await spillToolOutputToTempFile(
      "web-search-output",
      "head",
      { text: fullText, details: {} },
      "web-search",
    );

    expect(result.text).toContain("Showing the first");
    expect(result.text).not.toContain("�");
    expect(result.text).toContain("first");
    expect(result.text).not.toContain("last");
  });
});

describe("createCronTool", () => {
  it("lists recent run logs with detached session paths", async () => {
    const tool = createCronTool({
      workspace: { id: "batty", path: "/root/github/batty" } as any,
      cronService: {
        listRecentRunLogs: vi.fn(() => [
          {
            runId: "run-1",
            jobId: "job-1",
            workspaceId: "batty",
            prompt: "Inspect CI",
            model: "openai/gpt-5",
            thinkingLevel: "medium",
            session: { kind: "new" },
            scheduleLabel: "Every hour",
            startedAtMs: Date.parse("2026-08-31T12:00:00Z"),
            status: "success",
            completedAtMs: Date.parse("2026-08-31T12:01:00Z"),
            sessionPath: "/tmp/cron/run-1.jsonl",
          },
        ]),
      } as any,
      validateModel: vi.fn(),
      resolveSubagentDefaults: () => ({ modelId: "openai/gpt-5", thinkingLevel: "medium" }),
    });

    const result = await tool.execute(
      "tool-call-1",
      { action: "list-run-logs", limit: 10 },
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => "parent" } } as any,
    );

    expect(result.content[0]).toEqual(
      expect.objectContaining({ text: expect.stringContaining("/tmp/cron/run-1.jsonl") }),
    );
    expect(result.details).toMatchObject({ count: 1, workspaceId: "batty" });
  });

  it("validates the selected model before creating a job", async () => {
    const createJob = vi.fn();
    const validateModel = vi.fn(() => {
      throw new Error("Model not found: missing/model");
    });
    const tool = createCronTool({
      workspace: { id: "batty", path: "/root/github/batty" } as any,
      cronService: { createJob } as any,
      validateModel,
      resolveSubagentDefaults: () => ({ modelId: "openai/gpt-5", thinkingLevel: "medium" }),
    });

    await expect(
      tool.execute(
        "tool-call-2",
        {
          action: "add",
          prompt: "Inspect CI",
          model: "missing/model",
          thinkingLevel: "medium",
          schedule: { kind: "every", every: "1h" },
        },
        undefined,
        undefined,
        { sessionManager: { getSessionId: () => "parent" } } as any,
      ),
    ).rejects.toThrow("Model not found: missing/model");
    expect(validateModel).toHaveBeenCalledWith("missing/model");
    expect(createJob).not.toHaveBeenCalled();
  });

  it("validates a changed model before updating a job", async () => {
    const updateJob = vi.fn();
    const validateModel = vi.fn(() => {
      throw new Error("Model not found: missing/model");
    });
    const tool = createCronTool({
      workspace: { id: "batty", path: "/root/github/batty" } as any,
      cronService: { updateJob } as any,
      validateModel,
      resolveSubagentDefaults: () => ({ modelId: "openai/gpt-5", thinkingLevel: "medium" }),
    });

    await expect(
      tool.execute(
        "tool-call-3",
        { action: "update", jobId: "job-1", model: " missing/model " },
        undefined,
        undefined,
        { sessionManager: { getSessionId: () => "parent" } } as any,
      ),
    ).rejects.toThrow("Model not found: missing/model");
    expect(validateModel).toHaveBeenCalledWith("missing/model");
    expect(updateJob).not.toHaveBeenCalled();
  });
});

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

  it("starts concurrent detached subagent runs without serializing on the parent session", async () => {
    let resolveFirst: (() => void) | undefined;
    let resolveSecond: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const completions: Array<() => void> = [];
    const runDetachedSubagentSession = vi.fn(async () => {
      const index = completions.length;
      if (index === 0) {
        resolveFirst?.();
      } else {
        resolveSecond?.();
      }
      await new Promise<void>((resolve) => {
        completions.push(resolve);
      });
      return {
        text: `done-${index}`,
        details: {
          subagent: {
            prompt: "Inspect",
            model: "openai/gpt-5",
            effort: "medium",
            includeSessionContext: false,
            respondIn: "tool-call" as const,
            messageCount: 1,
          },
        },
        isError: false,
      };
    });
    const tool = createSubagentTool({
      workspace: { id: "batty", path: "/root/github/batty" } as any,
      config: {} as any,
      resolveSubagentDefaults: () => ({ modelId: "openai/gpt-5", thinkingLevel: "medium" }),
      runDetachedSubagentSession,
    });

    const first = tool.execute(
      "tool-call-1",
      { prompt: "Inspect A" },
      undefined,
      undefined,
      createContext(),
    );
    await firstStarted;
    const second = tool.execute(
      "tool-call-2",
      { prompt: "Inspect B" },
      undefined,
      undefined,
      createContext(),
    );
    await secondStarted;

    expect(runDetachedSubagentSession).toHaveBeenCalledTimes(2);
    expect(completions).toHaveLength(2);
    completions.forEach((complete) => complete());
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });
});
