import { describe, expect, it, vi } from "vite-plus/test";
import { parseClientMessageId, startEventStream } from "./sessions";

describe("parseClientMessageId", () => {
  it("accepts UUID client message IDs", () => {
    const id = crypto.randomUUID();
    expect(parseClientMessageId(id)).toBe(id);
  });

  it.each([undefined, "", "not-a-uuid"])("rejects invalid client message ID %s", (value) => {
    expect(() => parseClientMessageId(value)).toThrow("A valid clientMessageId is required");
  });
});

describe("startEventStream", () => {
  it("flushes idle stream headers immediately", () => {
    const writeHead = vi.fn();
    const flushHeaders = vi.fn();

    startEventStream({ writeHead, flushHeaders } as never);

    expect(writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    expect(flushHeaders).toHaveBeenCalledOnce();
    expect(writeHead.mock.invocationCallOrder[0]).toBeLessThan(
      flushHeaders.mock.invocationCallOrder[0]!,
    );
  });
});
