import { expect, test, vi } from "vite-plus/test";
import { mount } from "@vue/test-utils";
import ChatTranscript from "./ChatTranscript.vue";
import { buildTranscriptDisplayEntries } from "@/client/lib/transcript-display";
import type { SessionState, UiMessage } from "@/shared/types";
import { applyServerEvent } from "@/client/lib/session-events";

vi.mock("virtua/vue", () => ({
  Virtualizer: {
    props: ["data"],
    template: '<div><slot v-for="item in data" :item="item" /></div>',
  },
}));

test("shared transcript shows a failed run and clears it on incremental state and reset", async () => {
  let session = {
    sessionId: "main",
    messages: [],
    activeTools: [],
    availableThinkingLevels: [],
    totalMessageCount: 0,
    runFailure: "Run interrupted while answering: request cut off twice",
  } as unknown as SessionState;
  const wrapper = mount(ChatTranscript, {
    props: {
      historyEntries: [],
      tailEntries: [],
      keptHistoryIndexes: [],
      isStreaming: false,
      isPinnedToBottom: true,
      runFailure: session.runFailure,
    },
  });
  try {
    expect(wrapper.get('[role="alert"]').text()).toBe(session.runFailure);
    session = applyServerEvent(session, { type: "state", state: { runFailure: null } as never })!;
    await wrapper.setProps({ runFailure: session.runFailure });
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    session = applyServerEvent(session, {
      type: "reset",
      state: { ...session, runFailure: "Model unavailable: provider/model" },
    })!;
    await wrapper.setProps({ runFailure: session.runFailure });
    expect(wrapper.get('[role="alert"]').text()).toBe("Model unavailable: provider/model");
    session = applyServerEvent(session, {
      type: "reset",
      state: { ...session, runFailure: null },
    })!;
    await wrapper.setProps({ runFailure: session.runFailure });
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  } finally {
    wrapper.unmount();
  }
});

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

test("direct cron reply controls reveal only their own source session", async () => {
  const sources: UiMessage[] = [
    { ...messages[0]! },
    { ...messages[1]! },
    ...["run", "swim"].map((id) => ({
      id,
      role: "assistant" as const,
      timestamp: 4,
      turnPhase: "final" as const,
      blocks: [{ type: "text" as const, text: id }],
      directDelivery: { sessionId: `worker-${id}`, runId: id },
    })),
  ];
  const entriesFor = (openDetailsSectionKey?: string) =>
    buildTranscriptDisplayEntries(
      sources.map((message) => ({ message, toolStatesByCallId: tools })),
      tools,
      { openDetailsSectionKey },
    ).entries;
  const wrapper = mount(ChatTranscript, {
    props: {
      historyEntries: [],
      tailEntries: entriesFor(),
      keptHistoryIndexes: [],
      isStreaming: false,
      isPinnedToBottom: true,
    },
    global: {
      stubs: {
        SubagentSessionPopover: {
          props: ["sessionId"],
          template: '<div class="source-session">{{ sessionId }}</div>',
        },
      },
    },
  });
  try {
    const articles = wrapper.findAll("article");
    expect(articles.map((article) => article.text())).toEqual([
      "Question",
      "First answer",
      "run",
      "swim",
    ]);
    await articles[2]!.get('button[aria-label="Show details"]').trigger("click");
    expect(wrapper.emitted("toggleDetails")).toEqual([["turn:run"]]);
    await wrapper.setProps({ tailEntries: entriesFor("turn:run") });
    expect(wrapper.findAll(".source-session").map((source) => source.text())).toEqual([
      "worker-run",
    ]);
    expect(wrapper.text()).not.toContain("Work");
    expect(wrapper.findAll('button[aria-label="Collapse details"]')).toHaveLength(1);
    await wrapper.setProps({ tailEntries: entriesFor("turn:swim") });
    expect(wrapper.findAll(".source-session").map((source) => source.text())).toEqual([
      "worker-swim",
    ]);
  } finally {
    wrapper.unmount();
  }
});
