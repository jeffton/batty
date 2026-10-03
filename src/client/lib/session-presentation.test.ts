import { describe, expect, it } from "vite-plus/test";
import { presentSession } from "./session-presentation";
import { makeSnapshot } from "./session-test-fixture";

describe("native presentation", () => {
  it("joins args and final tool results from history, with nested details retained", () => {
    const snapshot = makeSnapshot();
    snapshot.messages = [
      {
        role: "assistant",
        id: "assistant-1",
        timestamp: 1,
        turnPhase: "intermediate",
        blocks: [{ type: "toolCall", id: "call", name: "codemode", arguments: { code: "run()" } }],
      },
      {
        role: "toolResult",
        id: "tool-2",
        durableEntryId: "2",
        timestamp: 2,
        toolCallId: "call",
        toolName: "codemode",
        blocks: [{ type: "text", text: "done" }],
        isError: false,
        details: { nestedCalls: { calls: [], complete: true } },
      },
    ];
    snapshot.documents = {
      ...snapshot.documents,
      "pi.live": {
        tools: [{ callId: "call", name: "codemode", status: "done", entry: 2 as never }],
      },
    };
    expect(presentSession(snapshot)?.activeTools[0]).toMatchObject({
      args: { code: "run()" },
      status: "success",
      blocks: [{ type: "text", text: "done" }],
      details: { nestedCalls: { calls: [], complete: true } },
    });
  });
  it("projects nested progress and deep parent identity from the current native slot", () => {
    const snapshot = makeSnapshot();
    snapshot.documents = {
      ...snapshot.documents,
      "pi.live": {
        tools: [
          {
            callId: "opaque/root",
            name: "codemode",
            status: "running",
            details: {
              nestedCalls: {
                complete: false,
                calls: [
                  {
                    id: "opaque/root/1",
                    name: "bash",
                    status: "unfinished",
                    arguments: { command: "build" },
                    output: "partial",
                  },
                  {
                    id: "opaque/root/1/2",
                    name: "read",
                    status: "error",
                    argumentsBytes: 100,
                    output: "failed preview",
                    error: "missing file",
                    durationMs: 12,
                  },
                ],
              },
            },
          },
        ],
      },
    };
    expect(presentSession(snapshot)?.activeTools).toMatchObject([
      { toolCallId: "opaque/root", toolName: "codemode" },
      {
        toolCallId: "opaque/root/1",
        parentToolCallId: "opaque/root",
        args: { command: "build" },
        status: "running",
        blocks: [{ type: "text", text: "partial" }],
      },
      {
        toolCallId: "opaque/root/1/2",
        parentToolCallId: "opaque/root/1",
        args: {},
        status: "error",
        isError: true,
        details: { error: "missing file", durationMs: 12, argumentsBytes: 100 },
      },
    ]);
  });

  it("uses exact committed nested completion without sharing outer artifacts", () => {
    const snapshot = makeSnapshot();
    snapshot.messages = [
      {
        role: "toolResult",
        id: "result",
        durableEntryId: "9",
        timestamp: 1,
        toolCallId: "root",
        toolName: "codemode",
        blocks: [],
        isError: false,
        details: {
          sentFiles: [{ id: "outer-artifact" } as never],
          nestedCalls: {
            complete: true,
            calls: [
              {
                id: "root/1",
                name: "bash",
                status: "ok",
                arguments: { command: "build" },
                output: "done",
                durationMs: 30,
              },
            ],
          },
        },
      },
    ];
    snapshot.documents = {
      ...snapshot.documents,
      "pi.live": {
        tools: [
          {
            callId: "root",
            name: "codemode",
            status: "done",
            entry: 9 as never,
            details: { nestedCalls: { calls: [], complete: false } },
          },
        ],
      },
    };
    const tools = presentSession(snapshot)!.activeTools;
    expect(tools).toHaveLength(2);
    expect(tools[1]).toMatchObject({
      status: "success",
      blocks: [{ type: "text", text: "done" }],
      details: { durationMs: 30 },
      isError: false,
    });
    expect(tools[1]!.details).not.toHaveProperty("sentFiles");
    snapshot.documents = { ...snapshot.documents, "pi.live": {} };
    expect(presentSession(snapshot)!.activeTools).toEqual([]);
  });

  it("does not reuse a historic result when a new round repeats the tool call ID", () => {
    const snapshot = makeSnapshot();
    snapshot.messages = [
      {
        role: "toolResult",
        id: "old-tool",
        durableEntryId: "2",
        timestamp: 1,
        toolCallId: "same-call",
        toolName: "bash",
        blocks: [{ type: "text", text: "old output" }],
        isError: false,
        details: { sentFiles: [{ id: "old-artifact" } as never] },
      },
      {
        role: "toolResult",
        id: "new-tool",
        durableEntryId: "8",
        timestamp: 2,
        toolCallId: "same-call",
        toolName: "bash",
        blocks: [{ type: "text", text: "new result" }],
        isError: true,
        details: { marker: "new" },
      },
    ];
    for (const status of ["pending", "running"] as const) {
      snapshot.documents = {
        ...snapshot.documents,
        "pi.live": {
          tools: [
            {
              callId: "same-call",
              name: "bash",
              status,
              output: "new partial",
              details: { marker: "live" },
            },
          ],
        },
      };
      expect(presentSession(snapshot)?.activeTools[0]).toMatchObject({
        blocks: [{ type: "text", text: "new partial" }],
        details: { marker: "live" },
        isError: false,
      });
      expect(presentSession(snapshot)?.activeTools[0]?.details).not.toHaveProperty("sentFiles");
    }
    snapshot.documents = {
      ...snapshot.documents,
      "pi.live": {
        tools: [{ callId: "same-call", name: "bash", status: "done", entry: 8 as never }],
      },
    };
    expect(presentSession(snapshot)?.activeTools[0]).toMatchObject({
      blocks: [{ type: "text", text: "new result" }],
      details: { marker: "new" },
      status: "error",
    });
    snapshot.documents = {
      ...snapshot.documents,
      "pi.live": {
        tools: [{ callId: "same-call", name: "bash", status: "done", output: "faulted progress" }],
      },
    };
    expect(presentSession(snapshot)?.activeTools[0]).toMatchObject({
      blocks: [{ type: "text", text: "faulted progress" }],
      isError: true,
    });
  });

  it("derives image+text queue and client IDs from native inbox", () => {
    const snapshot = makeSnapshot();
    snapshot.documents = {
      ...snapshot.documents,
      "pi.inbox": {
        items: [
          {
            id: 42 as never,
            mode: "steer",
            content: [
              { type: "image", mimeType: "image/png", data: "pixels" },
              { type: "text", text: "look" },
            ],
          },
        ],
      },
    };
    snapshot.queuedClientMessageIds = { "42": "client-a" };
    expect(presentSession(snapshot)?.queuedPrompts?.[0]).toMatchObject({
      submissionId: 42,
      text: "look",
      clientMessageId: "client-a",
      blocks: [
        { type: "image", mimeType: "image/png", data: "pixels" },
        { type: "text", text: "look" },
      ],
    });
  });
});
