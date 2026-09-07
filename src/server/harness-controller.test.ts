import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context, getOrThrow } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("AgentHarness controller", () => {
  it("durably accepts before model work and resumes without a second user message", async () => {
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
    expect(restored.snapshot.operation?.id).toBe(admission.operationId);
    f.faux.setResponses([fauxAssistantMessage("done")]);
    await restored.resume();
    expect(restored.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(restored.messages[0]).toMatchObject({ clientMessageId: "client-1" });
    expect(restored.snapshot.lastResult).toMatchObject({
      operationId: admission.operationId,
      status: "completed",
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

  it("does not repeat an uncertain mutating custom tool after close", async () => {
    const started = deferred();
    const release = deferred();
    let calls = 0;
    const f = await fixture({
      tools: [
        {
          name: "effect",
          label: "effect",
          description: "effect",
          parameters: Type.Object({}),
          replay: "never",
          async execute() {
            calls++;
            started.resolve();
            await release.promise;
            return { content: [{ type: "text", text: "effect done" }], details: {} };
          },
        },
      ],
    });
    f.faux.setResponses([
      fauxAssistantMessage([{ type: "toolCall", id: "call", name: "effect", arguments: {} }]),
    ]);
    const running = f.session.prompt("work").catch((error) => error);
    await started.promise;
    const restored = await f.reopen();
    await running;
    expect(restored.snapshot.operation?.runningTools).toHaveLength(1);
    f.faux.setResponses([fauxAssistantMessage("recovered")]);
    await restored.resume();
    release.resolve();
    expect(calls).toBe(1);
    expect(restored.messages.find((message) => message.role === "toolResult")).toMatchObject({
      isError: true,
    });
    expect(restored.snapshot.lastResult?.status).toBe("completed");
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

  it("joins concurrent native recovery drivers for one operation", async () => {
    const f = await fixture();
    const started = deferred();
    const release = deferred();
    await f.session.lane.accept({ kind: "prompt", prompt: "work" }, context);
    f.faux.setResponses([
      async () => {
        started.resolve();
        await release.promise;
        return fauxAssistantMessage("once");
      },
    ]);
    const first = f.session.resume();
    await started.promise;
    const second = f.session.resume();
    release.resolve();
    await Promise.all([first, second]);
    expect(f.faux.state.callCount).toBe(1);
  });

  it("consumes persisted steer and follow-up messages through Pi after reopen", async () => {
    const f = await fixture();
    await f.session.lane.accept({ kind: "prompt", prompt: "initial" }, context);
    await f.session.lane.steer("steer", undefined, context);
    await f.session.lane.followUp("follow-up", undefined, context);
    const session = await f.reopen();
    f.faux.setResponses([
      fauxAssistantMessage("first answer"),
      fauxAssistantMessage("last answer"),
    ]);
    await session.resume();
    const users = session.messages.filter((message) => message.role === "user");
    expect(JSON.stringify(users)).toContain("steer");
    expect(JSON.stringify(users)).toContain("follow-up");
    expect(session.pendingMessageCount).toBe(0);
    expect(session.snapshot.lastResult?.status).toBe("completed");
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
