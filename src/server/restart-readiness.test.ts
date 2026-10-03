import { describe, expect, it, vi } from "vite-plus/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentSessionController } from "./agent-session-controller";
import { waitForRestartResponse } from "./restart-readiness";

function setup() {
  const entries: SessionEntry[] = [];
  const append = (id: string, message: ReturnType<typeof fauxAssistantMessage>) =>
    entries.push({
      type: "message",
      id,
      parentId: entries.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(),
      message,
    });
  append(
    "deploy-anchor",
    fauxAssistantMessage([{ type: "toolCall", id: "deploy", name: "bash", arguments: {} }], {
      stopReason: "toolUse",
    }),
  );
  let listener!: (event: AgentSessionEvent) => void;
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((callback: typeof listener) => {
    listener = callback;
    return unsubscribe;
  });
  const session = {
    isStreaming: true,
    pendingMessageCount: 12,
    sessionManager: { getBranch: () => entries },
    subscribe,
  } as unknown as AgentSessionController;
  return {
    append,
    unsubscribe,
    subscribe,
    session,
    emit: (event: AgentSessionEvent) => listener(event),
  };
}
describe("self-restart readiness", () => {
  it("waits for only the deploying response, not tools or queued follow-ups", async () => {
    const fixture = setup();
    let ready = false;
    const waiting = waitForRestartResponse(fixture.session, "deploy-anchor").then(() => {
      ready = true;
    });
    const tool = fauxAssistantMessage(
      [{ type: "toolCall", id: "other", name: "read", arguments: {} }],
      { stopReason: "toolUse" },
    );
    fixture.append("other-tool", tool);
    fixture.emit({ type: "message_end", message: tool });
    await Promise.resolve();
    expect(ready).toBe(false);
    const final = fauxAssistantMessage("Deployment handed off.");
    fixture.append("deploy-summary", final);
    fixture.emit({ type: "message_end", message: final });
    await waiting;
    expect(ready).toBe(true);
    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
    expect(fixture.session.pendingMessageCount).toBe(12);
  });
  it("recognizes its persisted summary when a delayed worker finds a streaming follow-up", async () => {
    const fixture = setup();
    fixture.append("deploy-summary", fauxAssistantMessage("Deployment handed off."));
    fixture.append(
      "follow-up-tool",
      fauxAssistantMessage([{ type: "toolCall", id: "slow", name: "bash", arguments: {} }], {
        stopReason: "toolUse",
      }),
    );
    await waitForRestartResponse(fixture.session, "deploy-anchor");
    expect(fixture.subscribe).not.toHaveBeenCalled();
  });
  it("does not mistake a retryable generation error for the final summary", async () => {
    const fixture = setup();
    let ready = false;
    const waiting = waitForRestartResponse(fixture.session, "deploy-anchor").then(() => {
      ready = true;
    });
    const error = fauxAssistantMessage("", { stopReason: "error", errorMessage: "retry" });
    fixture.append("failed-generation", error);
    fixture.emit({ type: "message_end", message: error });
    await Promise.resolve();
    expect(ready).toBe(false);
    const final = fauxAssistantMessage("Deployment handed off.");
    fixture.append("deploy-summary", final);
    fixture.emit({ type: "message_end", message: final });
    await waiting;
  });
});
