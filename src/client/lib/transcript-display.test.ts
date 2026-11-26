import { expect, test } from "vite-plus/test";
import { buildTranscriptDisplayEntries } from "./transcript-display";
import type { TranscriptMessageView } from "./transcript";
import type { UiMessage } from "@/shared/types";

const tools = new Map();
const user: UiMessage = {
  id: "u",
  role: "user",
  timestamp: 1,
  blocks: [{ type: "text", text: "Question" }],
};
function reply(
  id: string,
  extra: Partial<Extract<UiMessage, { role: "assistant" }>> = {},
): Extract<UiMessage, { role: "assistant" }> {
  return {
    id,
    role: "assistant",
    timestamp: 2,
    turnPhase: "final",
    blocks: [
      { type: "thinking", thinking: "Reasoning" },
      { type: "text", text: "Answer" },
    ],
    ...extra,
  };
}
function views(messages: UiMessage[]): TranscriptMessageView[] {
  return messages.map((message) => ({ message, toolStatesByCallId: tools }));
}
function display(messages: UiMessage[], options = {}) {
  return buildTranscriptDisplayEntries(views(messages), options).entries;
}

test("finished and persisted sections collapse, with one section control on the last reply", () => {
  const messages = [user, reply("a"), reply("b")];
  const collapsed = display(messages);
  expect(collapsed.map((entry) => entry.kind === "message" && entry.detailsToggle)).toEqual([
    undefined,
    undefined,
    { sectionKey: "turn:u", expanded: false },
  ]);
  expect(JSON.stringify(collapsed)).not.toContain("Reasoning");
  const expanded = display(messages, { openDetailsSectionKey: "turn:u" });
  expect(JSON.stringify(expanded)).toContain("Reasoning");
  expect(expanded.at(-1)).toMatchObject({ detailsToggle: { expanded: true } });
});

test("streaming expands only the active section, and finishing collapses it", () => {
  const messages = [
    user,
    reply("old"),
    { ...user, id: "next" },
    reply("live", { turnPhase: "intermediate" }),
  ];
  const running = display(messages, { isStreaming: true });
  expect(running[1]).toMatchObject({ detailsToggle: { expanded: false } });
  expect(running.at(-1)).not.toHaveProperty("detailsToggle");
  expect(JSON.stringify(running.at(-1))).toContain("Reasoning");
  messages[3] = reply("live");
  expect(display(messages).at(-1)).toMatchObject({
    detailsToggle: { sectionKey: "turn:next", expanded: false },
  });
});

test("cron/runtime sections run automatically and reply-less notices or aborts remain accessible", () => {
  const notice: UiMessage = {
    id: "cron",
    role: "custom",
    timestamp: 3,
    customType: "cron",
    text: "Cron notice",
    data: { cron: {} },
  };
  const messages = [user, reply("old"), notice, reply("cron-reply")];
  const running = display(messages, { isStreaming: true });
  expect(
    running.some((entry) => entry.kind === "message" && entry.entry.message.id === "cron"),
  ).toBe(true);
  const finished = display(messages);
  expect(finished.at(-1)).toMatchObject({ detailsToggle: { sectionKey: "turn:cron" } });
  expect(display([notice])).toEqual([
    { kind: "details-toggle", sectionKey: "turn:cron", expanded: false },
  ]);
  expect(JSON.stringify(display([notice], { openDetailsSectionKey: "turn:cron" }))).toContain(
    "Cron notice",
  );
  const aborted = reply("aborted", {
    turnPhase: "intermediate",
    stopReason: "aborted",
    blocks: [{ type: "thinking", thinking: "Interrupted work" }],
  });
  expect(JSON.stringify(display([user, aborted]))).not.toContain("Interrupted work");
  expect(display([user, aborted]).at(-1)).toMatchObject({
    kind: "details-toggle",
    expanded: false,
  });
  expect(JSON.stringify(display([user, aborted], { openDetailsSectionKey: "turn:u" }))).toContain(
    "Interrupted work",
  );
});

test("a resumed durable run keeps its interrupted generation in details without hiding unrelated replies", () => {
  const aborted = reply("partial", {
    runTaskId: "run",
    stopReason: "aborted",
    blocks: [{ type: "text", text: "**Jeg synes, tur" }],
  });
  const final = reply("complete", {
    runTaskId: "run",
    stopReason: "stop",
    blocks: [{ type: "text", text: "**Full reply**" }],
  });
  const collapsed = display([user, aborted, final]);
  expect(collapsed).toHaveLength(2);
  expect(collapsed.at(-1)).toMatchObject({ detailsToggle: { expanded: false } });
  expect(
    JSON.stringify(display([user, aborted, final], { openDetailsSectionKey: "turn:u" })),
  ).toContain("**Jeg synes, tur");
  expect(display([user, aborted, final], { alwaysShowDetails: true })).toHaveLength(3);
  expect(display([user, aborted])).toHaveLength(2);
  // A history page may start mid-run, and repeated restarts can leave several attempts.
  expect(display([aborted, final])).toHaveLength(1);
  expect(display([user, aborted, { ...aborted, id: "partial-again" }, final])).toHaveLength(2);
  expect(
    JSON.stringify(
      display([user, aborted, { ...aborted, id: "partial-again" }, final], {
        openDetailsSectionKey: "turn:u",
      }),
    ),
  ).toContain("partial-again");
  expect(display([user, aborted, { ...final, runTaskId: "other" }])).toHaveLength(3);
  expect(display([user, { ...aborted, runTaskId: undefined }, final])).toHaveLength(3);
  expect(display([user, { ...aborted, errorMessage: "Useful failure" }, final])).toHaveLength(3);
  expect(display([user, aborted, { ...user, id: "new" }, final])).toHaveLength(4);
});

test("silent cron turns retain details, and a sentinel after a real reply keeps its control", () => {
  const notice: UiMessage = {
    id: "cron",
    role: "custom",
    timestamp: 3,
    customType: "cron",
    text: "Cron notice",
  };
  const silent = reply("silent", {
    blocks: [
      { type: "thinking", thinking: "Silent work" },
      { type: "text", text: "NO_REPLY" },
    ],
  });
  expect(display([notice, silent])).toEqual([
    { kind: "details-toggle", sectionKey: "turn:cron", expanded: false },
  ]);
  const expanded = display([notice, silent], { openDetailsSectionKey: "turn:cron" });
  expect(JSON.stringify(expanded)).toContain("Silent work");
  expect(JSON.stringify(expanded)).toContain("NO_REPLY");
  expect(JSON.stringify(display([notice, silent], { alwaysShowDetails: true }))).toContain(
    "NO_REPLY",
  );
  expect(JSON.stringify(display([notice, silent], { isStreaming: true }))).toContain("Silent work");
  expect(silent.blocks).toContainEqual({ type: "text", text: "NO_REPLY" });
  const textOnly = reply("text-only", { blocks: [{ type: "text", text: " NO_REPLY\n" }] });
  expect(display([textOnly])).toEqual([
    { kind: "details-toggle", sectionKey: "turn:text-only", expanded: false },
  ]);
  expect(display([textOnly], { openDetailsSectionKey: "turn:text-only" })[0]).toMatchObject({
    kind: "message",
    entry: { message: textOnly },
  });
  const error = { ...textOnly, stopReason: "error" as const, errorMessage: "Useful failure" };
  const collapsedError = JSON.stringify(display([error]));
  expect(collapsedError).toContain("Useful failure");
  expect(collapsedError).not.toContain("NO_REPLY");
  const image = {
    ...textOnly,
    blocks: [
      ...textOnly.blocks,
      { type: "image" as const, url: "/image.png", mimeType: "image/png" },
    ],
  };
  const collapsedImage = JSON.stringify(display([image]));
  expect(collapsedImage).toContain("/image.png");
  expect(collapsedImage).not.toContain("NO_REPLY");
  const result = display([notice, reply("real"), silent]);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    entry: { message: { id: "real" } },
    detailsToggle: { sectionKey: "turn:cron" },
  });
});

test("empty final cron responses are not replies or toggle anchors", () => {
  const notice: UiMessage = {
    id: "cron-211153",
    role: "custom",
    timestamp: 3,
    customType: "batty-runtime-notice:cron",
    text: "Heartbeat result",
  };
  const empty = reply("211326", {
    stopReason: "stop",
    blocks: [{ type: "text", text: "" }],
  });
  const resultNotice = { ...notice, id: "subagent-result" };
  const final = reply("211384", { blocks: [{ type: "text", text: "Google Docs Markdown" }] });
  const finished = display([notice, empty, resultNotice, final]);
  expect(finished).toHaveLength(1);
  expect(finished[0]).toMatchObject({
    entry: { message: { id: "211384" } },
    detailsToggle: { sectionKey: "turn:cron-211153", expanded: false },
  });
  expect(display([notice, empty])).toEqual([
    { kind: "details-toggle", sectionKey: "turn:cron-211153", expanded: false },
  ]);
  expect(display([empty])).toEqual([]);
  // Preserve originals and the details preference; the renderer ignores blank text.
  expect(display([notice, empty], { alwaysShowDetails: true })).toHaveLength(2);
  const error = { ...empty, stopReason: "error" as const, errorMessage: "Useful error" };
  expect(JSON.stringify(display([error]))).toContain("Useful error");
  const attached = {
    ...empty,
    blocks: [{ type: "image" as const, url: "/image.png", mimeType: "image/png" }],
  };
  expect(display([attached])).toHaveLength(1);
  expect(empty.blocks).toEqual([{ type: "text", text: "" }]);
});

test("orphan tool results and runtime artifacts collapse without losing their payloads", () => {
  const orphan: UiMessage = {
    id: "tool-result",
    role: "toolResult",
    timestamp: 1,
    toolCallId: "call",
    toolName: "bash",
    isError: false,
    blocks: [{ type: "text", text: "Tool output" }],
  };
  expect(display([orphan])).toEqual([
    { kind: "details-toggle", sectionKey: "turn:tool-result", expanded: false },
  ]);
  expect(display([orphan], { openDetailsSectionKey: "turn:tool-result" })[0]).toMatchObject({
    kind: "message",
    entry: { message: orphan },
  });
  expect(display([orphan], { isStreaming: true })[0]).toMatchObject({
    kind: "message",
    entry: { message: orphan },
  });
  expect(display([orphan], { alwaysShowDetails: true })[0]).toMatchObject({
    kind: "message",
    entry: { message: orphan },
  });
});

test("errors remain visible and details preference has no duplicate controls", () => {
  const failed = reply("error", {
    blocks: [{ type: "thinking", thinking: "Reasoning" }],
    stopReason: "error",
    errorMessage: "Useful failure",
  });
  const result = display([user, failed]);
  expect(JSON.stringify(result)).toContain("Useful failure");
  expect(result.at(-1)).toHaveProperty("detailsToggle");
  const always = display([user, failed], { alwaysShowDetails: true });
  expect(JSON.stringify(always)).toContain("Reasoning");
  expect(always.every((entry) => entry.kind === "message" && !entry.detailsToggle)).toBe(true);
});
