import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vite-plus/test";
import ChatMessage from "@/client/components/ChatMessage.vue";
import type { ToolDisplayState } from "@/client/lib/transcript";
import type { UiMessage } from "@/shared/types";

describe("ChatMessage", () => {
  it("renders attach-files results at the end of the assistant response", () => {
    const message: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-1",
      role: "assistant",
      timestamp: 1,
      blocks: [
        { type: "text", text: "Here you go." },
        {
          type: "toolCall",
          id: "call-1",
          name: "attach-files",
          arguments: { paths: ["dist/report.png", "dist/demo.mp4"] },
        },
      ],
    };
    const toolStatesByCallId = new Map<string, ToolDisplayState>([
      [
        "call-1",
        {
          status: "success",
          resultBlocks: [{ type: "text", text: "Attached 2 files for the user." }],
          resultDetails: {
            sentFiles: [
              {
                id: "image-1",
                name: "report.png",
                size: 2048,
                mimeType: "image/png",
                kind: "image",
                downloadUrl: "/api/sent-files/workspace/session/call/image-1?download=1",
                previewUrl: "/api/sent-files/workspace/session/call/image-1",
              },
              {
                id: "video-1",
                name: "demo.mp4",
                size: 4096,
                mimeType: "video/mp4",
                kind: "video",
                downloadUrl: "/api/sent-files/workspace/session/call/video-1?download=1",
                previewUrl: "/api/sent-files/workspace/session/call/video-1",
              },
            ],
          },
        },
      ],
    ]);

    const wrapper = mount(ChatMessage, {
      props: {
        message,
        toolStatesByCallId,
      },
    });

    expect(wrapper.text()).toContain("Here you go.");
    expect(wrapper.findAll(".attached-files__card")).toHaveLength(4);
    expect(wrapper.findAll("img.attached-files__preview")).toHaveLength(1);
    expect(wrapper.findAll("video.attached-files__preview")).toHaveLength(1);
    expect(wrapper.find("img.attached-files__preview").attributes("src")).toBe(
      "/api/sent-files/workspace/session/call/image-1",
    );
    expect(wrapper.find("video.attached-files__preview").attributes("src")).toBe(
      "/api/sent-files/workspace/session/call/video-1",
    );
  });
});
