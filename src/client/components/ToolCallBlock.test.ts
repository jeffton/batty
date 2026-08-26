import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vite-plus/test";
import ToolCallBlock from "@/client/components/ToolCallBlock.vue";

function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line-${index + 1}`).join("\n");
}

describe("ToolCallBlock", () => {
  it("shows read offset and limit inline without duplicating them in generic metadata", () => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        name: "read",
        arguments: {
          path: "src/server/main.ts",
          offset: 260,
          limit: 80,
        },
        status: "success",
      },
    });

    expect(wrapper.find(".tool-call__meta--read").text()).toContain("offset");
    expect(wrapper.find(".tool-call__meta--read").text()).toContain("limit");
    expect(wrapper.findAll(".tool-call__meta-row")).toHaveLength(0);
  });

  it("hides edit arguments when a diff is available", () => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        name: "edit",
        arguments: {
          path: "src/client/components/ToolCallBlock.test.ts",
          edits: [
            {
              oldText: "before",
              newText: "after",
            },
          ],
        },
        resultDetails: {
          diff: "@@ -1 +1 @@\n- before\n+ after",
        },
        status: "success",
      },
    });

    expect(wrapper.find(".tool-call__meta").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("oldText");
    expect(wrapper.text()).not.toContain("newText");
    expect(wrapper.text()).toContain("src/client/components/ToolCallBlock.test.ts");
  });

  it.each([
    ["bash", "$"],
    ["powershell", "PS>"],
  ])("tails %s output and expands to the full output on demand", async (name, prompt) => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        name,
        arguments: {
          command: "pnpm test",
        },
        resultBlocks: [{ type: "text", text: lines(30) }],
        status: "success",
      },
    });

    const blocks = wrapper.findAll("pre.code-block");
    expect(blocks[0]?.text()).toContain(`${prompt} pnpm test`);
    expect(blocks[1]?.text()).toContain("line-30");
    expect(blocks[1]?.text()).toContain("line-11");
    expect(blocks[1]?.text()).not.toContain("line-10");
    expect(wrapper.text()).toContain("Show full output");

    await wrapper.get(".tool-call__expand-btn").trigger("click");

    const expandedBlocks = wrapper.findAll("pre.code-block");
    expect(expandedBlocks[1]?.text()).toContain("line-1");
    expect(wrapper.text()).toContain("Collapse output");
  });

  it.each(["find", "grep"])("renders %s output as monospaced code", (name) => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        name,
        arguments: {},
        resultBlocks: [{ type: "text", text: "src/example.ts:12:match" }],
        status: "success",
      },
    });

    expect(wrapper.get("pre.code-block").text()).toBe("src/example.ts:12:match");
    expect(wrapper.find(".tool-call__text").exists()).toBe(false);
  });

  it("tails write content and expands to the full buffer on demand", async () => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        name: "write",
        arguments: {
          path: "src/client/components/ToolCallBlock.vue",
          content: lines(30),
        },
        status: "success",
      },
    });

    expect(wrapper.find("pre.code-block").text()).toContain("line-30");
    expect(wrapper.find("pre.code-block").text()).toContain("line-11");
    expect(wrapper.find("pre.code-block").text()).not.toContain("line-10");
    expect(wrapper.find(".tool-call__output-window--collapsed").exists()).toBe(true);

    await wrapper.get(".tool-call__expand-btn").trigger("click");

    expect(wrapper.find("pre.code-block").text()).toContain("line-1");
    expect(wrapper.find(".tool-call__output-window--collapsed").exists()).toBe(false);
  });

  it("shows cron arguments before output and expands to the full output on demand", async () => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        name: "cron",
        arguments: {
          action: "add",
          prompt: "Run the report",
          schedule: { kind: "every", every: "1h" },
        },
        resultBlocks: [{ type: "text", text: lines(30) }],
        status: "success",
      },
    });

    const text = wrapper.text();
    expect(text.indexOf("ACTION")).toBeLessThan(text.indexOf("line-1"));
    expect(wrapper.findAll(".tool-call__meta-row")).toHaveLength(3);
    expect(wrapper.find("pre.code-block").text()).toContain("line-1");
    expect(wrapper.find("pre.code-block").text()).toContain("line-20");
    expect(wrapper.find("pre.code-block").text()).not.toContain("line-21");
    expect(wrapper.text()).toContain("Show full output");

    await wrapper.get(".tool-call__expand-btn").trigger("click");

    expect(wrapper.find("pre.code-block").text()).toContain("line-30");
    expect(wrapper.text()).toContain("Collapse output");
  });

  it("shows web-search arguments before output and expands to the full output on demand", async () => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        name: "web-search",
        arguments: {
          action: "search",
          query: "batty",
          count: 10,
        },
        resultBlocks: [{ type: "text", text: lines(30) }],
        status: "success",
      },
    });

    const text = wrapper.text();
    expect(text.indexOf("ACTION")).toBeLessThan(text.indexOf("line-1"));
    expect(wrapper.find("pre.code-block").text()).toContain("line-1");
    expect(wrapper.find("pre.code-block").text()).toContain("line-20");
    expect(wrapper.find("pre.code-block").text()).not.toContain("line-21");
    expect(wrapper.text()).toContain("Show full output");

    await wrapper.get(".tool-call__expand-btn").trigger("click");

    expect(wrapper.find("pre.code-block").text()).toContain("line-30");
    expect(wrapper.text()).toContain("Collapse output");
  });

  it("renders attached files as download links without inline previews", () => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        name: "attach-files",
        arguments: {
          paths: ["dist/report.png", "dist/demo.mp4", "dist/archive.zip"],
        },
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
            {
              id: "file-1",
              name: "archive.zip",
              size: 8192,
              mimeType: "application/zip",
              kind: "file",
              downloadUrl: "/api/sent-files/workspace/session/call/file-1?download=1",
            },
          ],
        },
        status: "success",
      },
    });

    expect(wrapper.findAll(".attached-files__card")).toHaveLength(3);
    expect(wrapper.find("img.attached-files__preview").exists()).toBe(false);
    expect(wrapper.find("video.attached-files__preview").exists()).toBe(false);
    expect(wrapper.findAll(".attached-files__download").at(2)?.attributes("download")).toBe(
      "archive.zip",
    );
    expect(wrapper.findAll(".attached-files__download").at(0)?.attributes("target")).toBe(
      undefined,
    );
    expect(wrapper.text()).toContain("report.png");
    expect(wrapper.text()).toContain("archive.zip");
  });

  it("does not repeat session-mode subagent text or attachments in the tool call display", () => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        name: "subagent",
        arguments: {
          prompt: "Check the repo",
        },
        resultBlocks: [{ type: "text", text: "Full subagent response" }],
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
          ],
          subagent: {
            prompt: "Check the repo",
            model: "openai/gpt-5",
            effort: "medium",
            includeSessionContext: true,
            respondIn: "session",
            messageCount: 3,
            workspaceId: "workspace",
            sessionId: "subagent-123",
            sessionPath: "/tmp/subagent-123.jsonl",
          },
        },
        status: "success",
      },
    });

    expect(wrapper.text()).toContain("Check the repo");
    expect(wrapper.text()).toContain("Open session");
    expect(wrapper.text()).not.toContain("Full subagent response");
    expect(wrapper.findAll(".attached-files__card")).toHaveLength(0);
    expect(wrapper.find("img.attached-files__preview").exists()).toBe(false);
  });

  it("hides subagent session buttons when session popovers are disabled", () => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        name: "subagent",
        arguments: {
          prompt: "Check the repo",
        },
        resultDetails: {
          subagent: {
            respondIn: "tool-call",
            workspaceId: "workspace",
            sessionId: "subagent-123",
            sessionPath: "/tmp/subagent-123.jsonl",
          },
        },
        status: "success",
        allowSessionPopovers: false,
      },
    });

    expect(wrapper.text()).not.toContain("Open session");
    expect(wrapper.find(".tool-call__subagent-btn").exists()).toBe(false);
  });

  it("renders tool-call mode subagent responses as markdown", () => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        name: "subagent",
        arguments: {
          prompt: "Check the repo",
        },
        resultBlocks: [
          {
            type: "text",
            text: "## Full subagent response\n\nIncludes **important** findings and `code`.",
          },
        ],
        resultDetails: {
          subagent: {
            prompt: "Check the repo",
            model: "openai/gpt-5",
            effort: "medium",
            includeSessionContext: true,
            respondIn: "tool-call",
            messageCount: 3,
            workspaceId: "workspace",
            sessionId: "subagent-123",
            sessionPath: "/tmp/subagent-123.jsonl",
          },
        },
        status: "success",
      },
    });

    expect(wrapper.text()).toContain("Open session");
    const markdown = wrapper.get(".markdown-body");
    expect(markdown.text()).toContain("Full subagent response");
    expect(markdown.get("strong").text()).toBe("important");
    expect(markdown.get("code").text()).toBe("code");
    expect(wrapper.find(".tool-call__text").exists()).toBe(false);
  });

  it("renders subagent attachments from nested attach-files results", () => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        name: "subagent",
        arguments: {
          prompt: "Build the report",
        },
        resultDetails: {
          sentFiles: [
            {
              id: "file-1",
              name: "report.zip",
              size: 8192,
              mimeType: "application/zip",
              kind: "file",
              downloadUrl: "/api/sent-files/workspace/session/call/file-1?download=1",
            },
          ],
          subagent: {
            prompt: "Build the report",
            model: "openai/gpt-5",
            effort: "medium",
            includeSessionContext: true,
            respondIn: "tool-call",
            messageCount: 4,
          },
        },
        status: "success",
      },
    });

    expect(wrapper.findAll(".attached-files__card")).toHaveLength(1);
    expect(wrapper.text()).toContain("report.zip");
  });
});
