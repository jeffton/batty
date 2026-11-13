import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { expect, test, vi } from "vite-plus/test";
import type { Context, ImageContent } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { prepareProviderImage, projectProviderImages } from "./provider-images";
import { preparePromptFiles } from "./uploads";
import { withModelStreamTimeout } from "./model-stream-timeout";

async function avif(): Promise<Buffer> {
  return sharp({ create: { width: 48, height: 32, channels: 4, background: "#28aacc" } })
    .avif({ lossless: true })
    .toBuffer();
}

test("AVIF upload retains exact original bytes and metadata but admits a decoded PNG", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-avif-"));
  try {
    const original = await avif();
    const prepared = await preparePromptFiles(directory, "1", [
      { filename: "reference.avif", data: original },
    ]);
    const image = prepared.images[0]!;
    expect(image.mimeType).toBe("image/png");
    expect(await sharp(Buffer.from(image.data, "base64")).metadata()).toMatchObject({
      format: "png",
      width: 48,
      height: 32,
    });
    const stored = prepared.uploadedImages[0]!;
    expect(stored.mimeType).toBe("image/avif");
    expect(Buffer.from(stored.data, "base64")).toEqual(original);
    expect(await fs.readFile(path.join(directory, "1", stored.batchId, stored.storedName))).toEqual(
      original,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("historical AVIF user and tool images are projected on every later request without mutation", async () => {
  const image: ImageContent = {
    type: "image",
    mimeType: "image/avif",
    data: (await avif()).toString("base64"),
  };
  const request: Context = {
    messages: [
      { role: "user", content: [image], timestamp: 1 },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "read-1",
        content: [image],
        isError: false,
        timestamp: 2,
      },
    ],
  };
  const original = structuredClone(request);
  const models = createModels();
  models.setProvider(fauxProvider({ models: [{ id: "image-test" }] }).provider);
  const model = models.getModel("faux", "image-test")!;
  const provider = vi.fn((_model, projected: Context) => {
    for (const message of projected.messages) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content)
        if (block.type === "image") {
          expect(block.mimeType).toBe("image/png");
          expect(Buffer.from(block.data, "base64").subarray(0, 8).toString("hex")).toBe(
            "89504e470d0a1a0a",
          );
        }
    }
    const stream = new AssistantMessageEventStream();
    stream.push({
      type: "done",
      reason: "stop",
      message: fauxAssistantMessage([fauxText("image understood")]),
    });
    return stream;
  });
  const stream = withModelStreamTimeout(provider, projectProviderImages);
  expect((await stream(model, request).result()).stopReason).toBe("stop");
  request.messages.push({ role: "user", content: "Continue after a PNG upload", timestamp: 3 });
  expect((await stream(model, request).result()).stopReason).toBe("stop");
  expect(provider).toHaveBeenCalledTimes(2);
  expect(request.messages.slice(0, 2)).toEqual(original.messages);
});

test.each(["image/svg+xml", "image/tiff"])("converts decoder-supported %s", async (mimeType) => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>',
  );
  const data = mimeType === "image/tiff" ? await sharp(svg).tiff().toBuffer() : svg;
  const image = await prepareProviderImage({
    type: "image",
    mimeType,
    data: data.toString("base64"),
  });
  expect(await sharp(Buffer.from(image.data, "base64")).metadata()).toMatchObject({
    format: "png",
    width: 20,
    height: 10,
  });
});

test("bad image conversion is a visible stream error, never a provider call or silently omitted image", async () => {
  const provider = vi.fn();
  const models = createModels();
  models.setProvider(fauxProvider({ models: [{ id: "bad-image" }] }).provider);
  const result = await withModelStreamTimeout(provider, projectProviderImages)(
    models.getModel("faux", "bad-image")!,
    {
      messages: [
        {
          role: "user",
          content: [{ type: "image", mimeType: "image/avif", data: "YnJva2Vu" }],
          timestamp: 1,
        },
      ],
    },
  ).result();
  expect(result).toMatchObject({
    stopReason: "error",
    errorMessage: expect.stringContaining("Cannot convert image/avif"),
  });
  expect(provider).not.toHaveBeenCalled();
});
