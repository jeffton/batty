import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  findCutPoint,
  type Entry,
  BACKGROUND_CONTEXT as context,
} from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createHarnessFixture } from "./harness-test-fixture";

const fixtures: Awaited<ReturnType<typeof createHarnessFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

async function setup() {
  const f = await createHarnessFixture({
    compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 20 },
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
    tools: [
      {
        name: "read",
        label: "read",
        description: "read",
        parameters: Type.Object({}),
        replay: "safe",
        async execute() {
          return { content: [{ type: "text", text: "x".repeat(10000) }], details: {} };
        },
      },
    ],
  });
  f.faux.getModel().contextWindow = 1000;
  fixtures.push(f);
  return f;
}

describe("native Pi compaction", () => {
  it("retains the preceding assistant call when trailing results exceed the retention budget", () => {
    const messageEntry = (id: string, message: unknown): Entry =>
      ({ type: "message", id, parentId: null, seq: 1, timestamp: 1, message }) as Entry;
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

  it("compacts at the tool boundary before the next assistant request", async () => {
    const f = await setup();
    let summaries = 0;
    f.session.harness.hooks.on("before_compaction", ({ preparation }) => {
      summaries++;
      return {
        compaction: {
          summary: "Read complete",
          retainedTail: [],
          tokensBefore: preparation.tokensBefore,
        },
      };
    });
    f.faux.setResponses([
      fauxAssistantMessage([{ type: "toolCall", id: "read", name: "read", arguments: {} }]),
      (providerContext) => {
        expect(JSON.stringify(providerContext.messages)).toContain("Read complete");
        expect(JSON.stringify(providerContext.messages)).not.toContain("x".repeat(100));
        return fauxAssistantMessage("done");
      },
    ]);
    await f.session.prompt("inspect");
    expect(summaries).toBe(1);
    expect(f.session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(
      true,
    );
  });

  it("stops instead of dispatching an oversized request after failed compaction", async () => {
    const f = await setup();
    f.faux.setResponses([
      fauxAssistantMessage([{ type: "toolCall", id: "read", name: "read", arguments: {} }]),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "summary failed" }),
    ]);
    await expect(f.session.prompt("inspect")).rejects.toThrow();
    expect(f.faux.state.callCount).toBe(2);
    expect(f.session.snapshot.lastResult?.status).toBe("failed");
  });

  it("cancels a durable manual compaction without starting summary generation", async () => {
    const f = await setup();
    await f.session.lane.appendMessage({ role: "user", content: "history", timestamp: 1 }, context);
    const accepted = await f.session.lane.accept({ kind: "compaction" }, context);
    expect(accepted.ok).toBe(true);
    await f.session.abort();
    expect(f.faux.state.callCount).toBe(0);
  });
});
