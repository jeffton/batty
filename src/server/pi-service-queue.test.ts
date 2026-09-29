import { describe, expect, it, vi } from "vite-plus/test";
import type { WebSession } from "./pi-service-types";
import { getQueuedPrompts } from "./pi-service-queue";

describe("getQueuedPrompts", () => {
  it("preserves queued prompt identities from the session snapshot", () => {
    const prompts = [
      { kind: "steer" as const, index: 0, text: "first", clientMessageId: "client-1" },
      { kind: "followUp" as const, index: 0, text: "second", clientMessageId: "client-2" },
    ];
    const getSnapshotPrompts = vi.fn(() => prompts);
    const webSession = {
      session: { getQueuedPrompts: getSnapshotPrompts },
    } as unknown as WebSession;

    expect(getQueuedPrompts(webSession)).toBe(prompts);
    expect(getSnapshotPrompts).toHaveBeenCalledOnce();
  });
});
