import { mount } from "@vue/test-utils";
import { expect, test } from "vite-plus/test";
import ChatMessage from "../components/ChatMessage.vue";
import { changes, commentaryAttachments, image, site, video } from "../test/commentary-attachments";
import { buildToolStateLookup, buildTranscriptMessages } from "./transcript";
import { buildTranscriptDisplayEntries } from "./transcript-display";
import type { UiMessage } from "@/shared/types";

function transcript(messages: UiMessage[]) {
  return buildTranscriptMessages(messages, buildToolStateLookup(messages, []));
}

function render(messages: UiMessage[], id: string) {
  const entry = transcript(messages).find((entry) => entry.message.id === id)!;
  return mount(ChatMessage, {
    props: entry,
    global: { stubs: { AgentTurnDiffPopover: true, SharedSitesList: true } },
  });
}

test("attachments appear on their owning commentary and never in the tool result or later reply", () => {
  const messages = commentaryAttachments();
  const request = render(messages, "tool-request");
  const owner = render(messages, "commentary");
  const final = render(messages, "final");
  try {
    expect(request.text()).toContain("Prepared timelapse.");
    expect(request.text()).not.toContain("Unselected child");
    expect(request.find(".attached-files__card").exists()).toBe(false);
    expect(owner.get(".message__segment--bubble").text()).toContain("Here is the timelapse.");
    expect(owner.find(".message__segment--bubble video").exists()).toBe(true);
    expect(owner.findAll(".attached-files__card")).toHaveLength(2);
    expect(owner.findAll("shared-sites-list-stub")).toHaveLength(1);
    expect(owner.findAll(".message__diff-button")).toHaveLength(1);
    expect(final.find(".message__attachments").exists()).toBe(false);
  } finally {
    request.unmount();
    owner.unmount();
    final.unmount();
  }
});

test("an orphaned historic tool result retains its text without creating pending attachments", () => {
  const toolResult: UiMessage = {
    id: "result",
    role: "toolResult",
    timestamp: 1,
    toolCallId: "import",
    toolName: "attach_files",
    isError: false,
    blocks: [{ type: "text", text: "Imported image" }],
    details: { sentFiles: [image], sites: [site] },
  };
  const messages = [toolResult, commentaryAttachments().at(-1)!];
  expect(transcript(messages).map(({ message }) => message.id)).toEqual(["result", "final"]);
  const request = render(messages, "result");
  const final = render(messages, "final");
  try {
    expect(request.text()).toContain("Imported image");
    expect(request.find(".attached-files__card").exists()).toBe(false);
    expect(final.find(".message__attachments").exists()).toBe(false);
  } finally {
    request.unmount();
    final.unmount();
  }
});

test.each(["error", "aborted"] as const)(
  "a resumed %s keeps selected attachments on the interrupted reply",
  (stopReason) => {
    const messages: UiMessage[] = [
      {
        id: "interrupted",
        role: "assistant",
        timestamp: 1,
        turnPhase: "intermediate",
        runTaskId: "task",
        stopReason,
        blocks: [],
        sentFiles: [image],
      },
      {
        id: "resumed",
        role: "assistant",
        timestamp: 2,
        turnPhase: "final",
        runTaskId: "task",
        stopReason: "stop",
        blocks: [{ type: "text", text: "Done" }],
      },
    ];
    const display = buildTranscriptDisplayEntries(transcript(messages)).entries;
    expect(display).toMatchObject([
      { entry: { message: { id: "interrupted", sentFiles: [image] } } },
      { entry: { message: { id: "resumed" } } },
    ]);
    const resumed = display.at(-1);
    expect(resumed?.kind === "message" && resumed.entry.message).not.toHaveProperty("sentFiles");
  },
);

test.each(["subagent", "codemode"] as const)(
  "only a completed await shows its selected attachments within the %s report",
  (toolName) => {
    const presentation = { sentFiles: [video], sites: [site], fileChanges: changes };
    const messages = (["inspect", "failed", "await"] as const).flatMap<UiMessage>((id) => {
      const action = id === "inspect" ? "inspect" : "await";
      const failed = id === "failed";
      return [
        {
          id,
          role: "assistant",
          timestamp: 1,
          turnPhase: "intermediate",
          blocks: [{ type: "toolCall", name: toolName, id, arguments: { action } }],
        },
        {
          id: `${id}-result`,
          role: "toolResult",
          timestamp: 2,
          toolName,
          toolCallId: id,
          isError: failed,
          blocks: [{ type: "text", text: "Worker result" }],
          details:
            toolName === "subagent"
              ? { presentation }
              : {
                  calls: [
                    {
                      id,
                      name: "subagent",
                      args: JSON.stringify({ action }),
                      status: failed ? "error" : "ok",
                      presentation,
                    },
                  ],
                },
        },
      ];
    });
    messages.push(commentaryAttachments().at(-1)!);
    const inspect = render(messages, "inspect");
    const failed = render(messages, "failed");
    const awaitReport = render(messages, "await");
    const final = render(messages, "final");
    try {
      expect(inspect.find(".tool-report-attachments").exists()).toBe(false);
      expect(failed.find(".tool-report-attachments").exists()).toBe(false);
      const report = awaitReport.get(".tool-report-attachments");
      expect(report.get(".attached-files__card").text()).toContain("Timelapse.mp4");
      expect(report.find("shared-sites-list-stub").exists()).toBe(true);
      expect(report.get("button").text()).toContain("View changes 1");
      expect(final.find("video").exists()).toBe(false);
    } finally {
      inspect.unmount();
      failed.unmount();
      awaitReport.unmount();
      final.unmount();
    }
  },
);

test("a runtime report renders its message presentation, not descriptors from another report", () => {
  const notice: UiMessage = {
    id: "notice",
    role: "custom",
    timestamp: 1,
    customType: "batty-runtime-notice:subagent",
    text: "Worker result",
    data: {
      runtimePresentation: { sentFiles: [video], sites: [site], fileChanges: changes },
    },
  };
  const messages = [notice, { ...notice, id: "unrelated", data: {} }];
  const report = render(messages, "notice");
  const unrelated = render(messages, "unrelated");
  try {
    expect(report.find("video").exists()).toBe(true);
    expect(report.find("shared-sites-list-stub").exists()).toBe(true);
    expect(report.find(".message__diff-button").exists()).toBe(true);
    expect(unrelated.find(".message__attachments").exists()).toBe(false);
  } finally {
    report.unmount();
    unrelated.unmount();
  }
});
