import { afterEach, expect, test, vi } from "vite-plus/test";
import { createSiteMessageHandler } from "./site-functions";
import { SITE_CALL_CHANNEL, SITE_RESULT_CHANNEL } from "@/shared/site-functions";

const frames: HTMLIFrameElement[] = [];
afterEach(() => {
  frames.splice(0).forEach((frame) => frame.remove());
});

test("bridge binds the real iframe to its site; ignores forged senders and removes detached frames", async () => {
  const frame = document.createElement("iframe");
  frame.dataset.siteId = "own-site";
  document.body.append(frame);
  frames.push(frame);
  const post = vi.spyOn(frame.contentWindow!, "postMessage");
  const call = vi.fn(async () => ({ animal: "blue" }));
  const handler = createSiteMessageHandler(
    () => document.querySelectorAll("iframe[data-site-id]"),
    call,
  );
  const data = {
    channel: SITE_CALL_CHANNEL,
    documentId: "12345678901234567890123456789012",
    id: 1,
    name: "generate",
    siteId: "other-site",
    input: { sketch: "blue" },
  };
  await handler(new MessageEvent("message", { source: window, data }));
  expect(call).not.toHaveBeenCalled();
  await handler(new MessageEvent("message", { source: frame.contentWindow, origin: "null", data }));
  expect(call).toHaveBeenCalledExactlyOnceWith("own-site", "generate", { sketch: "blue" });
  expect(post).toHaveBeenCalledWith(
    { channel: SITE_RESULT_CHANNEL, documentId: data.documentId, id: 1, value: { animal: "blue" } },
    "*",
  );
  frame.remove();
  await handler(new MessageEvent("message", { source: frame.contentWindow, data }));
  expect(call).toHaveBeenCalledTimes(1);
});
