import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vite-plus/test";
import { BATTY_RUNTIME_NOTICE_CUSTOM_TYPE } from "@/server/runtime-notices";
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
    expect(wrapper.text()).not.toContain("attach-files");
    expect(wrapper.findAll(".attached-files__card")).toHaveLength(2);
    expect(wrapper.findAll("img.attached-files__preview")).toHaveLength(1);
    expect(wrapper.findAll("video.attached-files__preview")).toHaveLength(1);
    expect(wrapper.find("img.attached-files__preview").attributes("src")).toBe(
      "/api/sent-files/workspace/session/call/image-1",
    );
    expect(wrapper.find("video.attached-files__preview").attributes("src")).toBe(
      "/api/sent-files/workspace/session/call/video-1",
    );
    expect(wrapper.find(".message__segment--bubble .attached-files__card").exists()).toBe(true);
  });

  it("renders subagent attachments at the end of the outer assistant response", () => {
    const message: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-2",
      role: "assistant",
      timestamp: 2,
      blocks: [
        { type: "text", text: "Morning report" },
        {
          type: "toolCall",
          id: "subagent-1",
          name: "subagent",
          arguments: { prompt: "Build the morning report" },
        },
      ],
    };
    const toolStatesByCallId = new Map<string, ToolDisplayState>([
      [
        "subagent-1",
        {
          status: "success",
          resultBlocks: [],
          resultDetails: {
            sentFiles: [
              {
                id: "image-1",
                name: "webcam.jpg",
                size: 2048,
                mimeType: "image/jpeg",
                kind: "image",
                downloadUrl: "/api/sent-files/workspace/session/call/image-1?download=1",
                previewUrl: "/api/sent-files/workspace/session/call/image-1",
              },
            ],
            subagent: {
              prompt: "Build the morning report",
              model: "openai/gpt-5",
              effort: "medium",
              includeSessionContext: true,
              respondIn: "tool-call",
              messageCount: 3,
            },
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

    expect(wrapper.text()).toContain("Morning report");
    expect(wrapper.findAll(".attached-files__card")).toHaveLength(1);
    expect(wrapper.find("img.attached-files__preview").attributes("src")).toBe(
      "/api/sent-files/workspace/session/call/image-1",
    );
  });

  it("hides assistant thinking blocks from the parent transcript", () => {
    const message: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-thinking-1",
      role: "assistant",
      timestamp: 3,
      blocks: [
        { type: "thinking", thinking: "I should inspect the setup." },
        {
          type: "toolCall",
          id: "call-1",
          name: "subagent",
          arguments: { prompt: "Inspect" },
        },
      ],
    };

    const wrapper = mount(ChatMessage, {
      props: {
        message,
      },
    });

    expect(wrapper.text()).not.toContain("I should inspect the setup");
    expect(wrapper.text()).toContain("subagent");
  });

  it("renders assistant errors as red bubbles", () => {
    const message: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-error-1",
      role: "assistant",
      timestamp: 3,
      blocks: [],
      stopReason: "error",
      errorMessage: "Codex error: upstream overloaded",
    };

    const wrapper = mount(ChatMessage, {
      props: {
        message,
      },
    });

    expect(wrapper.text()).toContain("Codex error: upstream overloaded");
    expect(wrapper.find(".message__segment--error").exists()).toBe(true);
  });

  it("renders contentful assistant errors as red bubbles too", () => {
    const message: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-error-2",
      role: "assistant",
      timestamp: 4,
      blocks: [{ type: "text", text: "Codex error: upstream overloaded" }],
      stopReason: "error",
      errorMessage: "Codex error: upstream overloaded",
    };

    const wrapper = mount(ChatMessage, {
      props: {
        message,
      },
    });

    expect(wrapper.text()).toContain("Codex error: upstream overloaded");
    expect(wrapper.find(".message__segment--error").exists()).toBe(true);
  });

  it("renders system messages as blue bubbles with a cog icon", () => {
    const message: Extract<UiMessage, { role: "custom" }> = {
      id: "custom-1",
      role: "custom",
      timestamp: 3,
      customType: `${BATTY_RUNTIME_NOTICE_CUSTOM_TYPE}:subagent`,
      text: "Subagent run started.",
    };

    const wrapper = mount(ChatMessage, {
      props: {
        message,
      },
    });

    expect(wrapper.text()).toContain("Subagent run started.");
    expect(wrapper.find(".message__system-bubble").exists()).toBe(true);
    expect(wrapper.find(".message__system-icon svg").exists()).toBe(true);
  });
});
