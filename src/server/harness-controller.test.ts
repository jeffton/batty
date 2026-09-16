import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context, getOrThrow } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createHarnessFixture } from "./harness-test-fixture";

const fixtures: Awaited<ReturnType<typeof createHarnessFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});
async function fixture(options?: Parameters<typeof createHarnessFixture>[0]) {
  const fixture = await createHarnessFixture(options);
  fixtures.push(fixture);
  return fixture;
}

describe("AgentHarness controller", () => {
  it("aborts an interrupted durable operation when reopening without resuming it", async () => {
    const f = await fixture();
    const admission = getOrThrow(
      await f.session.lane.accept(
        {
          kind: "prompt",
          prompt: {
            role: "user",
            content: "work",
            timestamp: 1,
            clientMessageId: "client-1",
          } as never,
        },
        context,
      ),
    );
    expect(f.faux.state.callCount).toBe(0);
    expect(await fs.readFile(f.session.sessionFile, "utf8")).toContain(admission.operationId);

    const restored = await f.reopen();

    expect(f.faux.state.callCount).toBe(0);
    expect(restored.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(restored.messages[0]).toMatchObject({ clientMessageId: "client-1" });
    expect(restored.snapshot.lastResult).toMatchObject({
      operationId: admission.operationId,
      status: "aborted",
    });
    expect(restored.isStreaming).toBe(false);
  });

  it("restores and cancels durable queue entries without rebuilding their payloads", async () => {
    const f = await fixture();
    const first = getOrThrow(
      await f.session.lane.steer(
        {
          role: "user",
          content: [
            { type: "text", text: "one" },
            { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
          ],
          timestamp: 1,
        },
        undefined,
        context,
      ),
    );
    await f.session.lane.followUp("two", undefined, context);
    const restored = await f.reopen();
    expect(restored.pendingMessageCount).toBe(2);
    expect(restored.snapshot.queues[0]).toMatchObject({
      entryId: first.entryId,
      message: { content: expect.arrayContaining([expect.objectContaining({ type: "image" })]) },
    });
    await restored.removeQueuedPrompt("followUp", 0);
    expect(restored.getSteeringMessages()).toEqual(["one"]);
    expect(restored.getFollowUpMessages()).toEqual([]);
    expect((await f.reopen()).pendingMessageCount).toBe(1);
  });

  it("delivers transcript events only after the immutable entry exists", async () => {
    const f = await fixture();
    f.faux.setResponses([fauxAssistantMessage("answer")]);
    const observed: string[] = [];
    f.session.subscribe((event) => {
      if (event.type === "message_end") {
        expect(
          f.session.sessionManager
            .getBranch()
            .some((entry) => entry.type === "message" && entry.message.role === event.message.role),
        ).toBe(true);
        observed.push(event.message.role);
      }
    });
    await f.session.prompt("question");
    expect(observed).toEqual(["user", "assistant"]);
  });

  it("durably aborts an accepted operation before any effect", async () => {
    const f = await fixture();
    await f.session.lane.accept({ kind: "prompt", prompt: "work" }, context);
    await f.session.abort();
    expect(f.faux.state.callCount).toBe(0);
    expect(f.session.snapshot.lastResult?.status).toBe("aborted");
    expect((await f.reopen()).snapshot.operation).toBeNull();
  });
});
