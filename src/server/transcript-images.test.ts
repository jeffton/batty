import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import type { SessionState, UiContentBlock } from "@/shared/types";
import { TranscriptImages } from "./transcript-images";

const image: UiContentBlock = {
  type: "image",
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlXcAAAAASUVORK5CYII=",
};

test.each(["/", "/batty"])(
  "history and live tool images share public URLs at %s",
  async (baseUrl) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-image-urls-"));
    try {
      const images = new TranscriptImages(directory, baseUrl);
      const input = {
        messages: [
          { id: "user", role: "user", timestamp: 1, blocks: [image] },
          {
            id: "tool",
            role: "toolResult",
            timestamp: 2,
            toolCallId: "call",
            toolName: "codemode",
            isError: false,
            blocks: [image],
          },
        ],
        activeTools: [
          {
            toolCallId: "live",
            toolName: "codemode",
            args: {},
            status: "running",
            isError: false,
            blocks: [image],
          },
        ],
        activeAssistant: {
          id: "assistant",
          role: "assistant",
          timestamp: 3,
          turnPhase: "pending",
          blocks: [image],
        },
      } as SessionState;
      const original = JSON.stringify(input);
      const state = await images.state(input);
      const expectedUrl = `${baseUrl === "/" ? "" : baseUrl}/api/transcript-images/`;
      const blocks = [
        ...state.messages.flatMap((message) => ("blocks" in message ? message.blocks : [])),
        ...state.activeTools.flatMap((tool) => tool.blocks),
        ...state.activeAssistant!.blocks,
      ];
      for (const block of blocks) {
        expect(block).toMatchObject({ url: expect.stringContaining(expectedUrl) });
        expect(block).not.toHaveProperty("data");
      }
      expect(new Set(blocks.map((block) => (block.type === "image" ? block.url : ""))).size).toBe(
        1,
      );
      expect(JSON.stringify(input)).toBe(original);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);

test.each(["/", "/batty"])(
  "uploaded and attached images retain original links and receive previews at %s",
  async (baseUrl) => {
    const images = new TranscriptImages("unused", baseUrl);
    const prefix = baseUrl === "/" ? "" : baseUrl;
    const urls = [
      `${prefix}/api/uploads/1/batch/screenshot.png`,
      `${prefix}/api/sent-files/work/session/call/file?download=0`,
      "https://example.com/image.png",
      "data:image/png;base64,AA==",
    ];
    const result = await images.messages([
      {
        id: "user",
        role: "user",
        timestamp: 1,
        blocks: urls.map((url) => ({ type: "image", mimeType: "image/png", url })),
      },
    ]);
    expect(result[0]).toMatchObject({
      blocks: [
        { url: urls[0], previewUrl: `${urls[0]}?preview=1` },
        { url: urls[1], previewUrl: `${urls[1]}&preview=1` },
        { url: urls[2] },
        { url: urls[3] },
      ],
    });
    const blocks = "blocks" in result[0]! ? result[0].blocks : [];
    expect(blocks[2]).not.toHaveProperty("previewUrl");
    expect(blocks[3]).not.toHaveProperty("previewUrl");
  },
);
