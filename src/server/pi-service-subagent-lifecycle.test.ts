import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { PiService } from "./pi-service";
import * as subagents from "./pi-service-subagents";
import { TurnDrain } from "./turn-drain";
import type { DetachedSubagentOptions, DetachedSubagentResult } from "./pi-service-subagents";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function fixture() {
  const service = Object.create(PiService.prototype) as any;
  service.config = { battyDir: "/tmp/batty" };
  service.turns = new TurnDrain();
  service.runningSubagents = new Map();
  service.subagentOperationAsync = new Map();
  service.subagentOperations = new Map();
  const options: DetachedSubagentOptions = {
    sessionId: "child",
    workspace: { id: "test", path: "/tmp/test" } as DetachedSubagentOptions["workspace"],
    parentSessionId: "parent",
    parentSubagentDepth: 0,
    prompt: "initial",
    modelId: "faux/test",
    thinkingLevel: "off",
    includePreviousContext: false,
    respondIn: "session",
    deliveryMode: "prompt",
  };
  const result: DetachedSubagentResult = {
    deliveryEntryId: "reply",
    messages: [],
    generatedMessages: [],
    text: "done",
    details: { subagent: { sessionId: "child", sessionPath: "/tmp/child", workspaceId: "test" } },
    isError: false,
  };
  return { service, options, result };
}

afterEach(() => vi.restoreAllMocks());

describe("PiService subagent lifecycle", () => {
  it.each([false, true])(
    "advances FIFO at delivery acceptance while retaining admitted turns (continuation=%s)",
    async (continueSession) => {
      const { service, options, result } = fixture();
      const firstDelivery = barrier();
      const parentResponse = barrier();
      const secondDelivery = barrier();
      const thirdDelivery = barrier();
      const observed: string[] = [];
      const runner = vi
        .spyOn(subagents, "runDetachedSubagentSession")
        .mockImplementation(async (_deps, request) => {
          observed.push(request.prompt);
          request.onReady?.(result.details);
          if (request.prompt === "initial") {
            await firstDelivery.promise;
            request.onDelivered?.();
            await parentResponse.promise;
          } else {
            await (request.prompt === "second" ? secondDelivery : thirdDelivery).promise;
            request.onDelivered?.();
          }
          return result;
        });
      const first = service.runDetachedSubagentSession({ ...options, continueSession });
      await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
      const firstPending = service.subagentOperations.get("child");
      const second = service.runDetachedSubagentSession(
        { ...options, prompt: "second", continueSession: true },
        firstPending,
      );
      const secondPending = service.subagentOperations.get("child");
      const third = service.runDetachedSubagentSession(
        { ...options, prompt: "third", continueSession: true },
        secondPending,
      );
      const thirdPending = service.subagentOperations.get("child");
      expect(observed).toEqual(["initial"]);
      firstDelivery.release();
      await vi.waitFor(() => expect(observed).toEqual(["initial", "second"]));
      expect(service.turns.activeTurns).toBe(2);
      expect(service.subagentOperations.get("child")).toBe(thirdPending);
      parentResponse.release();
      await first;
      // The older response must not clear the newer running operation.
      expect(service.runningSubagents.get("child").prompt).toBe("second");
      secondDelivery.release();
      await second;
      await vi.waitFor(() => expect(observed).toEqual(["initial", "second", "third"]));
      thirdDelivery.release();
      await third;
      await thirdPending;
      expect(service.subagentOperations.size).toBe(0);
      expect(service.runningSubagents.size).toBe(0);
      expect(service.turns.activeTurns).toBe(0);
    },
  );

  it("releases failed operations so queued continuations can start", async () => {
    const { service, options, result } = fixture();
    const fail = barrier();
    vi.spyOn(subagents, "runDetachedSubagentSession").mockImplementation(async (_deps, request) => {
      request.onReady?.(result.details);
      if (request.prompt === "initial") {
        await fail.promise;
        throw new Error("delivery failed");
      }
      return result;
    });
    const first = service.runDetachedSubagentSession(options);
    const rejected = expect(first).rejects.toThrow("delivery failed");
    const second = service.runDetachedSubagentSession(
      { ...options, prompt: "second", continueSession: true },
      service.subagentOperations.get("child"),
    );
    fail.release();
    await rejected;
    await expect(second).resolves.toBe(result);
    await vi.waitFor(() => expect(service.subagentOperations.size).toBe(0));
    expect(service.runningSubagents.size).toBe(0);
    expect(service.turns.activeTurns).toBe(0);
  });

  it("checks continuation cancellation after its predecessor completes", async () => {
    const { service, options } = fixture();
    const previous = barrier();
    const controller = new AbortController();
    const runner = vi.spyOn(subagents, "runDetachedSubagentSession");
    const operation = service.runDetachedSubagentSession(
      { ...options, continueSession: true },
      previous.promise,
      controller.signal,
    );
    const rejected = expect(operation).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    expect(service.subagentOperations.has("child")).toBe(true);
    previous.release();
    await rejected;
    await vi.waitFor(() => expect(service.subagentOperations.size).toBe(0));
    expect(runner).not.toHaveBeenCalled();
    expect(service.turns.activeTurns).toBe(0);
  });
});
