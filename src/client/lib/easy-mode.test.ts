import { describe, expect, it } from "vite-plus/test";
import { easyModeMessage } from "@/client/lib/easy-mode";
import type { ToolDisplayState } from "@/client/lib/transcript";
import type { UiMessage } from "@/shared/types";

describe("easy mode", () => {
  it("keeps attachment tool calls so sent files render inside assistant responses", () => {
    const message: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-1",
      role: "assistant",
      turnPhase: "final",
      timestamp: 1,
      blocks: [
        { type: "thinking", thinking: "I will attach the file." },
        { type: "text", text: "Here is the report." },
        {
          type: "toolCall",
          id: "attach-1",
          name: "attach-files",
          arguments: { paths: ["webcam.jpg"] },
        },
      ],
    };
    const toolStatesByCallId = new Map<string, ToolDisplayState>([
      [
        "attach-1",
        {
          status: "success",
          resultBlocks: [{ type: "text", text: "Attached 1 file for the user." }],
          resultDetails: {
            sentFiles: [
              {
                id: "file-1",
                name: "webcam.jpg",
                size: 42,
                mimeType: "image/jpeg",
                kind: "image",
                downloadUrl: "/api/sent-files/file-1?download=1",
                previewUrl: "/api/sent-files/file-1",
              },
            ],
          },
        },
      ],
    ]);

    const filtered = easyModeMessage(message, toolStatesByCallId) as Extract<
      UiMessage,
      { role: "assistant" }
    >;

    expect(filtered.blocks).toEqual([
      { type: "text", text: "Here is the report." },
      message.blocks[2],
    ]);
  });
});
