// @vitest-environment node
import { expect, test, vi } from "vite-plus/test";
import { createOwnerRpcHandler, type OwnerRpcServices } from "./owner-rpc";
import type { Runtime } from "./runtime";

test("cancelled submissions do not enter the durable queue after asynchronous state/model work", async () => {
  for (const stage of ["state", "model"]) {
    const controller = new AbortController();
    const submit = vi.fn();
    const logSubmission = vi.fn();
    const runtime = {
      config: {},
      tools: {},
      main: { id: 1, submit },
      state: async () => {
        if (stage === "state") controller.abort();
        return { isStreaming: false };
      },
      useDefaultModel: async () => {
        if (stage === "model") controller.abort();
      },
    } as unknown as Runtime;
    const handler = createOwnerRpcHandler(runtime, {
      logSubmission,
    } as unknown as OwnerRpcServices);
    const correlationId = "01234567-89ab-cdef-0123-456789abcdef";
    await expect(
      handler(
        "main.submit",
        { kind: "prompt", text: "test", files: [], clientMessageId: "message-1", correlationId },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(submit).not.toHaveBeenCalled();
    expect(logSubmission).toHaveBeenCalledWith(correlationId);
  }
});

test("malformed repair previews cannot become mutating repairs", async () => {
  const repair = vi.fn().mockResolvedValue({ dryRun: true });
  const handler = createOwnerRpcHandler(
    { config: {}, tools: {}, memory: { repair } } as unknown as Runtime,
    {} as OwnerRpcServices,
  );
  const rpc = { signal: new AbortController().signal };
  for (const input of [
    { generation: 0, roots: [{ start: 0, count: 1 }] },
    { generation: 0, roots: [{ start: 0, count: 1 }], dryRun: "false" },
    { generation: -1, roots: [{ start: 0, count: 1 }], dryRun: true },
    { generation: 0, roots: [], dryRun: true },
    { generation: 0, roots: [{ start: 0, count: 0 }], dryRun: true },
  ])
    await expect(handler("memory.repair", input, rpc)).rejects.toMatchObject({ code: "BAD_INPUT" });
  expect(repair).not.toHaveBeenCalled();
  await handler(
    "memory.repair",
    { generation: 0, roots: [{ start: 0, count: 1 }], dryRun: true },
    rpc,
  );
  expect(repair).toHaveBeenCalledWith([{ start: 0, count: 1 }], 0, true);
});
