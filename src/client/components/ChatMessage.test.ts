import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vite-plus/test";
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

  it("copies assistant reply markdown", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const message: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-copy-1",
      role: "assistant",
      timestamp: 2,
      blocks: [
        { type: "text", text: "# Done\n\nHere you go." },
        { type: "image", mimeType: "image/png", url: "/preview.png", name: "preview.png" },
        {
          type: "toolCall",
          id: "call-1",
          name: "attach-files",
          arguments: { paths: ["dist/report.md"] },
        },
      ],
    };
    const toolStatesByCallId = new Map<string, ToolDisplayState>([
      [
        "call-1",
        {
          status: "success",
          resultBlocks: [{ type: "text", text: "Attached report." }],
          resultDetails: {
            sentFiles: [
              {
                id: "file-1",
                name: "report.md",
                size: 2048,
                mimeType: "text/markdown",
                kind: "file",
                downloadUrl: "/api/sent-files/workspace/session/call/file-1?download=1",
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

    await wrapper.find(".message__copy-button").trigger("click");

    expect(writeText).toHaveBeenCalledWith(
      "# Done\n\nHere you go.\n\n![preview.png](/preview.png)\n\n[report.md](/api/sent-files/workspace/session/call/file-1?download=1)",
    );
  });

  it("does not show the copy button for tool-call-only assistant messages", () => {
    const message: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-tool-only-1",
      role: "assistant",
      timestamp: 2,
      blocks: [
        {
          type: "toolCall",
          id: "call-1",
          name: "bash",
          arguments: { command: "pwd" },
        },
      ],
    };

    const wrapper = mount(ChatMessage, {
      props: {
        message,
      },
    });

    expect(wrapper.find(".message__copy-button").exists()).toBe(false);
  });

  it("places reply-leading content before an attachment-only response", () => {
    const message: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-attachment-only-1",
      role: "assistant",
      timestamp: 2,
      blocks: [
        {
          type: "toolCall",
          id: "call-1",
          name: "attach-files",
          arguments: { paths: ["dist/report.md"] },
        },
      ],
    };
    const toolStatesByCallId = new Map<string, ToolDisplayState>([
      [
        "call-1",
        {
          status: "success",
          resultBlocks: [{ type: "text", text: "Attached report." }],
          resultDetails: {
            sentFiles: [
              {
                id: "file-1",
                name: "report.md",
                size: 2048,
                mimeType: "text/markdown",
                kind: "file",
                downloadUrl: "/api/sent-files/workspace/session/call/file-1?download=1",
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
      slots: {
        "before-assistant-reply": '<button class="details-toggle">Show details</button>',
      },
    });

    const children = Array.from(wrapper.find(".message__body").element.children);
    expect(children).toHaveLength(2);
    expect(children[0]?.classList.contains("details-toggle")).toBe(true);
    expect(children[1]?.classList.contains("message__segment--bubble")).toBe(true);
    expect(wrapper.find(".message__copy-button").exists()).toBe(false);
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

  it("renders assistant thinking summaries with the existing italic styling", () => {
    const message: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-thinking-1",
      role: "assistant",
      timestamp: 3,
      blocks: [
        { type: "thinking", thinking: "Inspecting the setup." },
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

    expect(wrapper.text()).toContain("Inspecting the setup.");
    expect(wrapper.find(".markdown-body--thinking").exists()).toBe(true);
    expect(wrapper.find(".message__copy-button").exists()).toBe(false);
    expect(wrapper.text()).toContain("subagent");
  });

  it("renders reply-leading content between details and the response bubble", () => {
    const message: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-details-1",
      role: "assistant",
      timestamp: 3,
      blocks: [
        { type: "thinking", thinking: "Inspecting the setup." },
        { type: "text", text: "The setup is ready." },
      ],
    };

    const wrapper = mount(ChatMessage, {
      props: { message },
      slots: {
        "before-assistant-reply": '<button class="details-toggle">Collapse details</button>',
      },
    });

    const children = Array.from(wrapper.find(".message__body").element.children);
    expect(children).toHaveLength(3);
    expect(children[0]?.textContent).toContain("Inspecting the setup.");
    expect(children[1]?.classList.contains("details-toggle")).toBe(true);
    expect(children[2]?.classList.contains("message__segment--bubble")).toBe(true);
    expect(children[2]?.textContent).toContain("The setup is ready.");
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
      slots: {
        "before-assistant-reply": '<button class="details-toggle">Show details</button>',
      },
    });

    const children = Array.from(wrapper.find(".message__body").element.children);
    expect(children[0]?.classList.contains("details-toggle")).toBe(true);
    expect(children[1]?.classList.contains("message__segment--error")).toBe(true);
    expect(wrapper.text()).toContain("Codex error: upstream overloaded");
  });

  it("renders thinking before a failed response and keeps the error bubble", () => {
    const message: Extract<UiMessage, { role: "assistant" }> = {
      id: "assistant-thinking-error-1",
      role: "assistant",
      timestamp: 4,
      blocks: [{ type: "thinking", thinking: "Retrying the request." }],
      stopReason: "error",
      errorMessage: "Codex error: upstream overloaded",
    };

    const wrapper = mount(ChatMessage, {
      props: {
        message,
      },
    });

    expect(wrapper.text()).toContain("Retrying the request.");
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

  it("hides cron session buttons when session popovers are disabled", () => {
    const message: Extract<UiMessage, { role: "custom" }> = {
      id: "custom-cron-1",
      role: "custom",
      timestamp: 4,
      customType: `${BATTY_RUNTIME_NOTICE_CUSTOM_TYPE}:cron`,
      text: "Cron run finished.",
      data: {
        cron: {
          workspaceId: "batty",
          sessionPath: "/tmp/cron-session.jsonl",
          runId: "run-1",
          prompt: "Check status",
        },
      },
    };

    const wrapper = mount(ChatMessage, {
      props: {
        message,
        allowSessionPopovers: false,
      },
    });

    expect(wrapper.text()).toContain("Cron run finished.");
    expect(wrapper.find(".message__notice-btn").exists()).toBe(false);
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
