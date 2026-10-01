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

  it("heads read output and expands to the full output on demand", async () => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        name: "read",
        arguments: {
          path: "src/server/main.ts",
        },
        resultBlocks: [{ type: "text", text: lines(30) }],
        status: "success",
      },
    });

    expect(wrapper.get("pre.code-block").text()).toContain("line-1");
    expect(wrapper.get("pre.code-block").text()).toContain("line-20");
    expect(wrapper.get("pre.code-block").text()).not.toContain("line-21");
    expect(wrapper.find(".tool-call__output-window--collapsed-start").exists()).toBe(true);
    expect(wrapper.text()).toContain("Show full output (+10 lines)");

    await wrapper.get(".tool-call__expand-btn").trigger("click");

    expect(wrapper.get("pre.code-block").text()).toContain("line-30");
    expect(wrapper.find(".tool-call__output-window--collapsed").exists()).toBe(false);
    expect(wrapper.text()).toContain("Collapse output");
  });

  it.each(["read", "write"])("syntax-highlights TypeScript %s output", (name) => {
    const source = "const answer: number = 42;";
    const wrapper = mount(ToolCallBlock, {
      props: {
        name,
        arguments: {
          path: "src/example.ts",
          ...(name === "write" ? { content: source } : {}),
        },
        resultBlocks: name === "read" ? [{ type: "text", text: source }] : [],
        status: "success",
      },
    });

    expect(wrapper.get(".hljs-keyword").text()).toBe("const");
    expect(wrapper.get(".hljs-number").text()).toBe("42");
  });

  it("also truncates failed read output at the end", () => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        name: "read",
        arguments: {
          path: "src/server/main.ts",
        },
        resultBlocks: [{ type: "text", text: lines(30) }],
        status: "error",
      },
    });

    expect(wrapper.get("pre.code-block").text()).toContain("line-1");
    expect(wrapper.get("pre.code-block").text()).toContain("line-20");
    expect(wrapper.get("pre.code-block").text()).not.toContain("line-21");
    expect(wrapper.text()).toContain("Show full output (+10 lines)");
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

  it("syntax-highlights edit output while preserving diff emphasis", () => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        name: "edit",
        arguments: {
          path: "src/example.ts",
          oldText: 'const answer = "before";',
          newText: 'const answer = "after";',
        },
        resultDetails: {
          diff: '@@ -1 +1 @@\n- const answer = "before";\n+ const answer = "after";',
        },
        status: "success",
      },
    });

    expect(wrapper.get(".diff-block .hljs-keyword").text()).toBe("const");
    expect(wrapper.findAll(".diff-block__inline-change")).toHaveLength(2);
    expect(wrapper.findAll(".hljs-string .diff-block__inline-change")).toHaveLength(2);
    expect(wrapper.find(".diff-block__line--remove").exists()).toBe(true);
    expect(wrapper.find(".diff-block__line--add").exists()).toBe(true);
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

  it.each(["find", "grep"])(
    "heads %s output and expands to the full monospaced output on demand",
    async (name) => {
      const wrapper = mount(ToolCallBlock, {
        props: {
          name,
          arguments: {},
          resultBlocks: [{ type: "text", text: lines(30) }],
          status: "success",
        },
      });

      expect(wrapper.get("pre.code-block").text()).toContain("line-1");
      expect(wrapper.get("pre.code-block").text()).toContain("line-20");
      expect(wrapper.get("pre.code-block").text()).not.toContain("line-21");
      expect(wrapper.find(".tool-call__text").exists()).toBe(false);
      expect(wrapper.find(".tool-call__output-window--collapsed").exists()).toBe(true);
      expect(wrapper.find(".tool-call__output-window--collapsed-start").exists()).toBe(true);
      expect(wrapper.text()).toContain("Show full output (+10 lines)");

      await wrapper.get(".tool-call__expand-btn").trigger("click");

      expect(wrapper.get("pre.code-block").text()).toContain("line-30");
      expect(wrapper.find(".tool-call__output-window--collapsed").exists()).toBe(false);
      expect(wrapper.text()).toContain("Collapse output");
    },
  );

  it("also truncates failed grep output at the end", () => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        name: "grep",
        arguments: {},
        resultBlocks: [{ type: "text", text: lines(30) }],
        status: "error",
      },
    });

    expect(wrapper.get("pre.code-block").text()).toContain("line-1");
    expect(wrapper.get("pre.code-block").text()).toContain("line-20");
    expect(wrapper.get("pre.code-block").text()).not.toContain("line-21");
    expect(wrapper.text()).toContain("Show full output (+10 lines)");
  });

  it.each(["bash", "powershell"])("previews long %s commands without output", async (name) => {
    const wrapper = mount(ToolCallBlock, {
      props: { name, arguments: { command: lines(15) }, status: "running" },
    });

    expect(wrapper.get("pre.code-block").text()).toContain("line-10");
    expect(wrapper.get("pre.code-block").text()).not.toContain("line-11");
    expect(wrapper.text()).toContain("Show full command and output");

    await wrapper.get(".tool-call__expand-btn").trigger("click");
    expect(wrapper.get("pre.code-block").text()).toContain("line-15");

    await wrapper.setProps({ resultBlocks: [{ type: "text", text: lines(30) }] });
    expect(wrapper.findAll("pre.code-block")[1]?.text()).toBe(lines(30));

    await wrapper.get(".tool-call__expand-btn").trigger("click");
    expect(wrapper.get("pre.code-block").text()).not.toContain("line-11");
    expect(wrapper.findAll("pre.code-block")[1]?.text()).toContain("line-30");
  });

  it("renders codemode code, live call summaries, and final output with Pi previews", async () => {
    const calls = Array.from({ length: 10 }, (_, index) => ({
      id: String(index),
      name: `tool-${index}`,
      args: "a".repeat(90),
      status: index === 9 ? "error" : "ok",
      durationMs: index === 9 ? 1500 : 25,
      ...(index === 9 ? { error: "Nested failure" } : {}),
      cost: 0.001,
    }));
    const wrapper = mount(ToolCallBlock, {
      props: {
        name: "codemode",
        arguments: { code: Array.from({ length: 15 }, (_, i) => `const v${i} = ${i};`).join("\n") },
        resultDetails: { calls },
        status: "running",
      },
    });

    expect(wrapper.find(".tool-call__meta").exists()).toBe(false);
    expect(wrapper.get(".hljs-keyword").text()).toBe("const");
    expect(wrapper.get("pre.code-block").text()).not.toContain("const v10");
    expect(wrapper.findAll(".codemode-display__call")).toHaveLength(8);
    expect(wrapper.text()).toContain("2 earlier calls");
    expect(wrapper.text()).not.toContain("tool-0");
    expect(wrapper.text()).toContain(`${"a".repeat(77)}...`);
    expect(wrapper.text()).toContain("1.5s");
    expect(wrapper.text()).toContain("Model calls: $0.01");
    expect(wrapper.text()).not.toContain("Nested failure");

    await wrapper.get(".tool-call__expand-btn").trigger("click");
    expect(wrapper.findAll(".codemode-display__call")).toHaveLength(10);
    expect(wrapper.get("pre.code-block").text()).toContain("const v14");
    expect(wrapper.text()).toContain("Nested failure");
    expect(wrapper.text()).toContain("a".repeat(90));

    await wrapper.setProps({
      status: "error",
      resultBlocks: [
        { type: "text", text: "Script failed\nWall time 1.5 seconds\nOutput:\n" },
        { type: "text", text: lines(30) },
      ],
    });
    expect(wrapper.findAll("pre.code-block")[1]?.text()).toBe(lines(30));
    expect(wrapper.text()).not.toContain("Script failed");

    await wrapper.get(".tool-call__expand-btn").trigger("click");
    expect(wrapper.findAll("pre.code-block")[1]?.text()).toBe(lines(5));
    expect(wrapper.text()).toContain("25 more output lines");
  });

  it("keeps live codemode calls updated without showing partial script output", async () => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        name: "codemode",
        arguments: { code: "await tools.read({ path: 'a' });" },
        resultBlocks: [{ type: "text", text: "Script completed\nWall time 0 seconds\nOutput:\n" }],
        resultDetails: {
          calls: [{ id: "1", name: "read", args: '{"path":"a"}', status: "running" }],
        },
        status: "running",
      },
    });

    expect(wrapper.get('[aria-label="running"]').text()).toBe("…");
    expect(wrapper.text()).not.toContain("Script completed");
    await wrapper.setProps({
      resultDetails: {
        calls: [{ id: "1", name: "read", args: '{"path":"a"}', status: "ok", durationMs: 12 }],
        fullOutputPath: "/tmp/output.txt",
      },
      status: "success",
      resultBlocks: [{ type: "text", text: "done" }],
    });
    expect(wrapper.get('[aria-label="ok"]').text()).toBe("✓");
    expect(wrapper.text()).toContain("12ms");
    expect(wrapper.text()).toContain("Full output: /tmp/output.txt");
    expect(wrapper.findAll("pre.code-block")[1]?.text()).toBe("done");
  });

  it("keeps concurrent codemode rows stable as temporary IDs complete and the preview slides", async () => {
    const calls = Array.from({ length: 10 }, (_, index) => ({
      id: "parent/?",
      name: `tool-${index}`,
      args: "{}",
      status: "running",
    }));
    const wrapper = mount(ToolCallBlock, {
      props: {
        name: "codemode",
        arguments: { code: "await Promise.all([]);" },
        resultDetails: { calls },
        status: "running",
      },
    });
    const originalRow = wrapper.findAll(".codemode-display__call")[1]!.element;

    await wrapper.setProps({
      resultDetails: {
        calls: [
          ...calls.map((call, index) => ({ ...call, id: `parent/${index}`, status: "ok" })),
          { id: "parent/?", name: "tool-10", args: "{}", status: "cancelled" },
        ],
      },
    });

    const rows = wrapper.findAll(".codemode-display__call");
    expect(rows).toHaveLength(8);
    expect(rows[0]!.element).toBe(originalRow);
    expect(rows[0]!.text()).toContain("tool-3");
    expect(wrapper.findAll('[aria-label="ok"]')).toHaveLength(7);
    expect(wrapper.get('[aria-label="cancelled"]').text()).toBe("⊘");

    await wrapper.get(".tool-call__expand-btn").trigger("click");
    expect(wrapper.findAll(".codemode-display__call")).toHaveLength(11);
    expect(wrapper.findAll(".codemode-display__call")[3]!.element).toBe(originalRow);
  });

  it("preserves codemode images alongside short monospaced text output", () => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        name: "codemode",
        arguments: {},
        resultBlocks: [
          { type: "text", text: "First result" },
          { type: "image", mimeType: "image/png", data: "cG5n" },
          { type: "text", text: "Second result" },
        ],
        status: "success",
      },
    });

    expect(wrapper.get("pre.code-block").text()).toBe("First result\nSecond result");
    expect(wrapper.find(".tool-call__expand-btn").exists()).toBe(false);
    expect(wrapper.find(".tool-call__text").exists()).toBe(false);
    expect(wrapper.get('img[alt="Tool output"]').attributes("src")).toBe(
      "data:image/png;base64,cG5n",
    );
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

  it.each([
    ["web-search", { action: "search", query: "batty", count: 10 }],
    ["browser", { action: "snapshot" }],
  ])("shows %s arguments before monospace output and expands from the head", async (name, args) => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        name,
        arguments: args,
        resultBlocks: [{ type: "text", text: lines(30) }],
        status: "success",
      },
    });

    const text = wrapper.text();
    expect(text.indexOf("ACTION")).toBeLessThan(text.indexOf("line-1"));
    expect(wrapper.find("pre.code-block").text()).toContain("line-1");
    expect(wrapper.find("pre.code-block").text()).toContain("line-20");
    expect(wrapper.find("pre.code-block").text()).not.toContain("line-21");
    expect(wrapper.find(".tool-call__output-window--collapsed-start").exists()).toBe(true);
    expect(wrapper.text()).toContain("Show full output (+10 lines)");

    await wrapper.get(".tool-call__expand-btn").trigger("click");

    expect(wrapper.find("pre.code-block").text()).toContain("line-30");
    expect(wrapper.text()).toContain("Collapse output");
  });

  it("renders browser screenshots with their text result", () => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        name: "browser",
        arguments: { action: "screenshot", viewport: { width: 1280, height: 720 } },
        resultBlocks: [
          { type: "text", text: "Screenshot captured." },
          { type: "image", mimeType: "image/png", data: "cG5n" },
        ],
        status: "success",
      },
    });

    expect(wrapper.get("pre.code-block").text()).toContain("Screenshot captured.");
    expect(wrapper.get('img[alt="Tool output"]').attributes("src")).toBe(
      "data:image/png;base64,cG5n",
    );
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
            includePreviousContext: true,
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

  it("shows the launch acknowledgement for async session-mode subagents", () => {
    const wrapper = mount(ToolCallBlock, {
      props: {
        name: "subagent",
        arguments: { prompt: "Check the repo", async: true },
        resultBlocks: [{ type: "text", text: "Started in /tmp/subagent-123.jsonl" }],
        resultDetails: {
          subagent: {
            respondIn: "session",
            async: true,
            workspaceId: "workspace",
            sessionId: "subagent-123",
            sessionPath: "/tmp/subagent-123.jsonl",
          },
        },
        status: "success",
      },
    });

    expect(wrapper.text()).toContain("Started in /tmp/subagent-123.jsonl");
    expect(wrapper.text()).toContain("Open session");
    expect(wrapper.find(".code-block code").text()).toBe("Started in /tmp/subagent-123.jsonl");
    expect(wrapper.find(".markdown-body").exists()).toBe(false);
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

  it.each(["await", "queue", "steer", "stop", "resume"])(
    "renders subagent %s acknowledgements with a session button",
    (action) => {
      const text = "Session ID: child_123\nStatus: **running**";
      const wrapper = mount(ToolCallBlock, {
        props: {
          name: "subagent",
          arguments: { action, sessionId: "child_123" },
          resultBlocks: [{ type: "text", text }],
          resultDetails: {
            subagent: {
              workspaceId: "workspace",
              sessionId: "child_123",
              sessionPath: "/tmp/child_123.jsonl",
            },
          },
          status: "success",
        },
      });

      expect(wrapper.find(".code-block code").text()).toBe(text);
      expect(wrapper.find(".markdown-body").exists()).toBe(false);
      expect(wrapper.get(".tool-call__subagent-btn").text()).toBe("Open session");
      expect(wrapper.get(".tool-call__subagent-btn").attributes("popovertarget")).toBe(
        "subagent-session-popover-child_123",
      );
    },
  );

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
            includePreviousContext: true,
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
            includePreviousContext: true,
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
