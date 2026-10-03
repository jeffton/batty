import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  findCutPoint,
  type SessionEntry,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createAgentSessionFixture } from "./agent-session-test-fixture";

const fixtures: Awaited<ReturnType<typeof createAgentSessionFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

async function setup(extensionFactories: ExtensionFactory[] = []) {
  const f = await createAgentSessionFixture({
    compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 20 },
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
    extensionFactories,
    tools: [
      {
        name: "large-read",
        label: "large-read",
        description: "read",
        parameters: Type.Object({}),
        async execute() {
          return { content: [{ type: "text", text: "x".repeat(10000) }], details: {} };
        },
      },
    ],
  });
  // Keep ordinary turns below the automatic threshold; overflow recovery is
  // triggered by an explicit provider error rather than prompt size.
  f.faux.getModel().contextWindow = 100000;
  fixtures.push(f);
  return f;
}

const summary: ExtensionFactory = (pi) => {
  pi.on("session_before_compact", ({ preparation }) => ({
    compaction: {
      summary: "History",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    },
  }));
};

describe("native Pi compaction", () => {
  it("retains the preceding assistant call when trailing results exceed the retention budget", () => {
    const messageEntry = (id: string, message: unknown): SessionEntry =>
      ({
        type: "message",
        id,
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message,
      }) as SessionEntry;
    const entries = [
      messageEntry("user", { role: "user", content: "Investigate", timestamp: 1 }),
      messageEntry(
        "assistant",
        fauxAssistantMessage([
          { type: "toolCall", id: "one", name: "read", arguments: {} },
          { type: "toolCall", id: "two", name: "read", arguments: {} },
        ]),
      ),
      ...["one", "two"].map((id) =>
        messageEntry(id, {
          role: "toolResult",
          toolCallId: id,
          toolName: "read",
          content: [{ type: "text", text: "x".repeat(80) }],
          isError: false,
          timestamp: 2,
        }),
      ),
    ];
    expect(findCutPoint(entries, 0, entries.length, 30)).toEqual({
      firstKeptEntryIndex: 1,
      turnStartIndex: 0,
      isSplitTurn: true,
    });
  });

  it("emits manual compaction lifecycle through the controller", async () => {
    const f = await setup([summary]);
    f.faux.setResponses([fauxAssistantMessage("history answer ".repeat(20))]);
    await f.session.prompt("history");
    const events: string[] = [];
    f.session.subscribe((event) => {
      if (event.type === "compaction_start" || event.type === "compaction_end")
        events.push(event.type);
    });
    await f.session.compact();
    expect(events).toEqual(["compaction_start", "compaction_end"]);
    expect(f.session.isCompacting).toBe(false);
    expect(f.session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(
      true,
    );
  });

  it("reports manual summary failure instead of hiding the error", async () => {
    const f = await setup();
    f.faux.setResponses([fauxAssistantMessage("history answer ".repeat(20))]);
    await f.session.prompt("history");
    f.faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "summary failed" }),
    ]);
    const calls = f.faux.state.callCount;
    await expect(f.session.compact()).rejects.toThrow("summary failed");
    expect(f.faux.state.callCount).toBe(calls + 1);
    expect(f.session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(
      false,
    );
    expect(f.session.isCompacting).toBe(false);
  });

  it("cancels manual compaction before dispatching summary generation", async () => {
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const f = await setup([
      (pi) => {
        pi.on("session_before_compact", async ({ signal }) => {
          started();
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { cancel: true };
        });
      },
    ]);
    f.faux.setResponses([fauxAssistantMessage("history answer ".repeat(20))]);
    await f.session.prompt("history");
    const calls = f.faux.state.callCount;
    const compact = expect(f.session.compact()).rejects.toThrow("Compaction cancelled");
    await start;
    expect(f.session.isCompacting).toBe(true);
    f.session.abortCompaction();
    await compact;
    expect(f.session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(
      false,
    );
    expect(f.faux.state.callCount).toBe(calls);
    expect(f.session.isCompacting).toBe(false);
  });

  it("recovers context overflow through native compaction and retries the turn", async () => {
    const f = await setup([summary]);
    f.faux.setResponses([fauxAssistantMessage("history answer ".repeat(20))]);
    await f.session.prompt("history");
    f.faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "maximum context length exceeded",
      }),
      fauxAssistantMessage("recovered"),
    ]);
    const events: unknown[] = [];
    f.session.subscribe((event) => {
      if (event.type === "compaction_start" || event.type === "compaction_end") events.push(event);
    });
    const calls = f.faux.state.callCount;
    await f.session.prompt("continue");
    expect(f.faux.state.callCount).toBe(calls + 2);
    expect(events).toMatchObject([
      { type: "compaction_start", reason: "overflow" },
      { type: "compaction_end", reason: "overflow" },
    ]);
    expect(f.session.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "recovered" }],
    });
    expect(f.session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(
      true,
    );
  });
});
