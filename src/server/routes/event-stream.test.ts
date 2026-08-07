import { describe, expect, it, vi } from "vite-plus/test";
import { startEventStream } from "./event-stream";

describe("startEventStream", () => {
  it("flushes stream headers immediately", () => {
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
