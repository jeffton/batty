import { expect, test, vi } from "vite-plus/test";
import { mount } from "@vue/test-utils";
import ChatTranscript from "./ChatTranscript.vue";
import { buildTranscriptDisplayEntries } from "@/client/lib/transcript-display";
import type { UiMessage } from "@/shared/types";

vi.mock("virtua/vue", () => ({
  Virtualizer: {
    props: ["data"],
    template: '<div><slot v-for="item in data" :item="item" /></div>',
  },
}));

const tools = new Map();
const messages: UiMessage[] = [
  { id: "u", role: "user", timestamp: 1, blocks: [{ type: "text", text: "Question" }] },
  {
    id: "a",
    role: "assistant",
    timestamp: 2,
    turnPhase: "final",
    blocks: [
      { type: "thinking", thinking: "Work" },
      { type: "text", text: "First answer" },
    ],
  },
  {
    id: "b",
    role: "assistant",
    timestamp: 3,
    turnPhase: "final",
    blocks: [{ type: "text", text: "Last answer" }],
    errorMessage: "Useful failure",
  },
];

for (const location of ["history", "tail"] as const) {
  test(`${location} has one details action on the last reply and emits the section key`, async () => {
    const entries = buildTranscriptDisplayEntries(
      messages.map((message) => ({ message, toolStatesByCallId: tools })),
      tools,
    ).entries;
    const wrapper = mount(ChatTranscript, {
      props: {
        historyEntries: location === "history" ? entries : [],
        tailEntries: location === "tail" ? entries : [],
        keptHistoryIndexes: [],
        isStreaming: false,
        isPinnedToBottom: true,
      },
    });
    try {
      const toggle = wrapper.get('button[aria-label="Show details"]');
      expect(wrapper.findAll('button[aria-label="Show details"]')).toHaveLength(1);
      expect(wrapper.findAll("article").at(-1)!.text()).toContain("Last answer");
      expect(wrapper.text()).toContain("Useful failure");
      expect(wrapper.findAll(".reply-actions")).toHaveLength(2);
      await toggle.trigger("click");
      expect(wrapper.emitted("toggleDetails")).toEqual([["turn:u"]]);
    } finally {
      wrapper.unmount();
    }
  });
}

for (const location of ["history", "tail"] as const) {
  test(`${location} renders orphan details as only the shared toggle`, async () => {
    const entries = [
      { kind: "details-toggle" as const, sectionKey: "turn:orphan", expanded: false },
    ];
    const wrapper = mount(ChatTranscript, {
      props: {
        historyEntries: location === "history" ? entries : [],
        tailEntries: location === "tail" ? entries : [],
        keptHistoryIndexes: [],
        isStreaming: false,
        isPinnedToBottom: true,
      },
    });
    try {
      expect(wrapper.findAll("article")).toHaveLength(0);
      expect(wrapper.findAll("button")).toHaveLength(1);
      expect(wrapper.text()).toBe("");
      const toggle = wrapper.get('button[aria-label="Show details"]');
      expect(toggle.attributes("aria-expanded")).toBe("false");
      await toggle.trigger("click");
      expect(wrapper.emitted("toggleDetails")).toEqual([["turn:orphan"]]);
    } finally {
      wrapper.unmount();
    }
  });
}

test("artifact-only and error-only replies each render exactly one action stack", () => {
  for (const extra of [
    { errorMessage: "Failed", stopReason: "error" as const },
    {
      sites: [
        {
          kind: "site" as const,
          id: "s",
          name: "Site",
          url: "https://example.com",
          public: false as const,
        },
      ],
    },
  ]) {
    const message = {
      id: "reply",
      role: "assistant",
      timestamp: 2,
      turnPhase: "final",
      blocks: [{ type: "thinking", thinking: "Work" }],
      ...extra,
    } as UiMessage;
    const entries = buildTranscriptDisplayEntries(
      [messages[0]!, message].map((message) => ({ message, toolStatesByCallId: tools })),
      tools,
    ).entries;
    const wrapper = mount(ChatTranscript, {
      props: {
        historyEntries: [],
        tailEntries: entries,
        keptHistoryIndexes: [],
        isStreaming: false,
        isPinnedToBottom: true,
      },
      global: { stubs: { SharedSitesList: true } },
    });
    try {
      expect(wrapper.findAll(".reply-actions")).toHaveLength(1);
      expect(wrapper.findAll('button[aria-label="Show details"]')).toHaveLength(1);
      expect(wrapper.findAll('button[aria-label="Copy reply as markdown"]')).toHaveLength(1);
    } finally {
      wrapper.unmount();
    }
  }
});
