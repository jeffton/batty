import { mount } from "@vue/test-utils";
import { expect, test } from "vite-plus/test";
import ChatMessage from "../components/ChatMessage.vue";
import { commentaryAttachments, image, site, video } from "../test/commentary-attachments";
import { buildToolStateLookup, buildTranscriptMessages } from "./transcript";
import type { UiMessage } from "@/shared/types";

function transcript(messages: UiMessage[]) {
  return buildTranscriptMessages(messages, buildToolStateLookup(messages, []));
}

function render(messages: UiMessage[], id = "commentary") {
  const entry = transcript(messages).find((entry) => entry.message.id === id)!;
  return mount(ChatMessage, {
    props: entry,
    global: { stubs: { AgentTurnDiffPopover: true, SharedSitesList: true, ToolCallBlock: true } },
  });
}

test("native outputs and explicit forwards attach to commentary once, before final and on replay", () => {
  for (const messages of [commentaryAttachments().slice(0, 4), commentaryAttachments()]) {
    const wrapper = render(messages);
    try {
      expect(wrapper.findAll("video")).toHaveLength(1);
      expect(wrapper.findAll(".attached-files__card")).toHaveLength(2);
      expect(wrapper.text()).not.toContain("Unselected child");
      expect(wrapper.findAll(".message__segment--bubble")).toHaveLength(1);
      expect(wrapper.get(".message__segment--bubble").text()).toContain("Here is the timelapse.");
      expect(wrapper.find(".message__segment--bubble video").exists()).toBe(true);
      expect(wrapper.findAll("shared-sites-list-stub")).toHaveLength(1);
      expect(wrapper.findAll(".message__diff-button")).toHaveLength(1);
      if (messages.length > 4) {
        const final = render(messages, "final");
        expect(final.findAll(".message__artifacts")).toHaveLength(0);
        final.unmount();
      }
    } finally {
      wrapper.unmount();
    }
  }
});

for (const name of ["attach_files", "sites"] as const) {
  test(`${name} waits for its result and attaches after, not to preceding request text`, () => {
    const messages: UiMessage[] = [
      {
        id: "request",
        role: "assistant",
        timestamp: 1,
        turnPhase: "intermediate",
        blocks: [
          { type: "text", text: "Preparing" },
          { type: "toolCall", id: "attach", name, arguments: {} },
        ],
      },
      {
        id: "result",
        role: "toolResult",
        timestamp: 2,
        toolCallId: "attach",
        toolName: name,
        isError: false,
        blocks: [],
        details: {
          sentFiles: name === "attach_files" ? [video] : [],
          sites: name === "sites" ? [site] : [],
        },
      },
      {
        id: "commentary",
        role: "assistant",
        timestamp: 3,
        turnPhase: "intermediate",
        blocks: [
          { type: "image", mimeType: image.mimeType, url: image.previewUrl, name: "Reply image" },
        ],
        sentFiles: name === "attach_files" ? [video] : [],
        sites: name === "sites" ? [site] : [],
      },
    ];
    const entries = transcript(messages);
    expect(entries.find((entry) => entry.message.id === "request")!.message).toMatchObject({
      blocks: [{ type: "text", text: "Preparing" }],
    });
    const reply = entries.find((entry) => entry.message.id === "commentary")!;
    expect(reply.toolStatesByCallId.get("attach")?.resultDetails).toEqual(
      messages[1]!.role === "toolResult" ? messages[1]!.details : undefined,
    );
    const wrapper = render(messages);
    expect(wrapper.findAll("video")).toHaveLength(name === "attach_files" ? 1 : 0);
    expect(wrapper.findAll("shared-sites-list-stub")).toHaveLength(name === "sites" ? 1 : 0);
    wrapper.unmount();
  });
}

test("successful native effects survive an outer codemode error, without forwarding child reports", () => {
  const messages = commentaryAttachments();
  (messages[2] as Extract<UiMessage, { role: "toolResult" }>).isError = true;
  const wrapper = render(messages);
  expect(wrapper.findAll("video")).toHaveLength(1);
  expect(wrapper.text()).not.toContain("Unselected child");
  wrapper.unmount();
});

test("received worker reports are not attachment carriers", () => {
  const messages = commentaryAttachments();
  messages[2] = {
    ...(messages[2] as Extract<UiMessage, { role: "toolResult" }>),
    toolName: "subagent",
  };
  const commentary = messages[3] as Extract<UiMessage, { role: "assistant" }>;
  delete commentary.sentFiles;
  delete commentary.sites;
  delete commentary.fileChanges;
  expect(
    transcript(messages).find((entry) => entry.message.id === "commentary")?.toolStatesByCallId
      .size,
  ).toBe(1);
  const wrapper = render(messages);
  expect(wrapper.findAll(".message__artifacts")).toHaveLength(0);
  wrapper.unmount();
});

test("failed direct attachment calls remain visible errors and do not become carriers", () => {
  const messages: UiMessage[] = [
    {
      id: "request",
      role: "assistant",
      timestamp: 1,
      turnPhase: "intermediate",
      blocks: [{ type: "toolCall", id: "failed", name: "attach_files", arguments: {} }],
    },
    {
      id: "failure",
      role: "toolResult",
      timestamp: 2,
      toolCallId: "failed",
      toolName: "attach_files",
      isError: true,
      blocks: [{ type: "text", text: "Import failed" }],
      details: { sentFiles: [video] },
    },
    {
      id: "commentary",
      role: "assistant",
      timestamp: 3,
      turnPhase: "intermediate",
      blocks: [{ type: "text", text: "Could not import" }],
    },
  ];
  expect(transcript(messages)[0]!.toolStatesByCallId.get("failed")).toMatchObject({
    status: "error",
    resultBlocks: [{ type: "text", text: "Import failed" }],
  });
  expect(
    transcript(messages).find((entry) => entry.message.id === "commentary")!.toolStatesByCallId
      .size,
  ).toBe(0);
});

test("site-only native codemode output is an attachment, not a synthetic tool bubble", () => {
  const messages = commentaryAttachments();
  const result = messages[2] as Extract<UiMessage, { role: "toolResult" }>;
  result.details = {
    sites: [site],
    calls: [{ id: "site", name: "sites", args: "{}", status: "ok", sites: [site] }],
  };
  const commentary = messages[3] as Extract<UiMessage, { role: "assistant" }>;
  delete commentary.sentFiles;
  delete commentary.fileChanges;
  const wrapper = render(messages);
  expect(wrapper.findAll("shared-sites-list-stub")).toHaveLength(1);
  expect(wrapper.findAll("tool-call-block-stub")).toHaveLength(1); // real await, not synthetic carrier
  expect(wrapper.findAll(".attached-files__card")).toHaveLength(0);
  wrapper.unmount();
});

const interleavings: Array<[string, UiMessage[]]> = [
  [
    "worker notice",
    [
      {
        id: "notice",
        role: "custom",
        timestamp: 3,
        customType: "batty-runtime-notice:subagent",
        text: "Another worker completed",
      },
    ],
  ],
  [
    "user steer",
    [
      {
        id: "steer",
        role: "user",
        timestamp: 3,
        blocks: [{ type: "text", text: "Continue the other task too" }],
      },
    ],
  ],
  [
    "unreferenced tool result",
    [
      {
        id: "orphan-result",
        role: "toolResult",
        timestamp: 3,
        toolCallId: "orphan",
        toolName: "read",
        isError: false,
        blocks: [{ type: "text", text: "Other tool output" }],
      },
    ],
  ],
  [
    "referenced tool result",
    [
      {
        id: "read-call",
        role: "assistant",
        timestamp: 3,
        turnPhase: "intermediate",
        blocks: [{ type: "toolCall", id: "read", name: "read", arguments: {} }],
      },
      {
        id: "read-result",
        role: "toolResult",
        timestamp: 3,
        toolCallId: "read",
        toolName: "read",
        isError: false,
        blocks: [{ type: "text", text: "Read output" }],
      },
    ],
  ],
  [
    "direct cron delivery",
    [
      {
        id: "direct",
        role: "assistant",
        timestamp: 3,
        turnPhase: "final",
        directDelivery: { sessionId: "cron", runId: "cron-run" },
        blocks: [{ type: "text", text: "Independent reminder" }],
      },
    ],
  ],
];

for (const [label, interleaved] of interleavings) {
  test(`${label} neither flushes nor consumes native output before its owning commentary`, () => {
    const messages = commentaryAttachments();
    messages.splice(3, 0, ...interleaved);
    const entries = transcript(messages);
    expect(entries.some((entry) => entry.message.id.endsWith(":attachments"))).toBe(false);
    const wrappers = entries.map((entry) =>
      mount(ChatMessage, {
        props: entry,
        global: {
          stubs: { AgentTurnDiffPopover: true, SharedSitesList: true, ToolCallBlock: true },
        },
      }),
    );
    expect(wrappers.reduce((count, wrapper) => count + wrapper.findAll("video").length, 0)).toBe(1);
    for (const wrapper of wrappers) wrapper.unmount();
    const owner = render(messages);
    expect(owner.findAll(".attached-files__card")).toHaveLength(2);
    owner.unmount();
  });
}

test("native output stays visible at the end while waiting for the next owning response", () => {
  const messages = commentaryAttachments().slice(0, 3);
  messages.push(...interleavings[0]![1], ...interleavings[1]![1]);
  const entries = transcript(messages);
  expect(entries.at(-1)!.message.id).toBe("tool-result:attachments");
  const pending = render(messages, "tool-result:attachments");
  expect(pending.findAll(".attached-files__card")).toHaveLength(2);
  pending.unmount();
});

test("empty commentary does not consume a pending native attachment", () => {
  const messages = commentaryAttachments();
  messages.splice(3, 0, {
    id: "empty",
    role: "assistant",
    timestamp: 3,
    turnPhase: "intermediate",
    blocks: [{ type: "text", text: " \n " }],
  });
  const entries = transcript(messages);
  expect(entries.find((entry) => entry.message.id === "empty")!.toolStatesByCallId.size).toBe(0);
  const wrapper = render(messages);
  expect(wrapper.findAll(".attached-files__card")).toHaveLength(2);
  wrapper.unmount();
});
