import { expect, test } from "vite-plus/test";
import { buildTranscriptDisplayEntries } from "./transcript-display";
import { buildToolStateLookup, buildTranscriptMessages } from "./transcript";
import type { UiMessage } from "@/shared/types";

// The main transcript around subagent 146858: another worker's result arrived
// after launch but before the final reply, followed later by the spacing result.
export const runtimeMessages: UiMessage[] = [
  { id: "146845", role: "user", timestamp: 1, blocks: [{ type: "text", text: "Fix spacing" }] },
  {
    id: "146855",
    role: "assistant",
    timestamp: 2,
    turnPhase: "intermediate",
    blocks: [
      {
        type: "toolCall",
        id: "launch",
        name: "subagent",
        arguments: { action: "run", prompt: "Header spacing task" },
      },
    ],
  },
  {
    id: "146866",
    role: "toolResult",
    timestamp: 3,
    toolCallId: "launch",
    toolName: "subagent",
    isError: false,
    blocks: [{ type: "text", text: "Started. Session ID: 146858" }],
  },
  {
    id: "146870",
    role: "custom",
    timestamp: 4,
    customType: "batty-runtime-notice:subagent",
    text: "[subagent 146278 result] Codemode deployed",
  },
  {
    id: "146874",
    role: "assistant",
    timestamp: 5,
    turnPhase: "final",
    blocks: [{ type: "text", text: "Codemode-fixet er live. Logoets spacing-fix kører stadig" }],
  },
  {
    id: "147048",
    role: "custom",
    timestamp: 6,
    customType: "batty-runtime-notice:subagent",
    text: "[subagent 146858 result] Spacing deployed",
  },
  {
    id: "147053",
    role: "assistant",
    timestamp: 7,
    turnPhase: "final",
    blocks: [{ type: "text", text: "Spacing er rettet og live" }],
  },
];

function display(messages: UiMessage[], options = {}) {
  const lookup = buildToolStateLookup(messages, []);
  return buildTranscriptDisplayEntries(
    buildTranscriptMessages(messages, lookup, false),
    lookup.toolStatesByCallId,
    options,
  ).entries;
}

test("an async notice during tool work does not strand the launch in an expanded reply-less section", () => {
  const running = display(runtimeMessages.slice(0, 4), { isStreaming: true });
  expect(JSON.stringify(running)).toContain("Header spacing task");
  expect(running.every((entry) => entry.kind === "message" && !entry.detailsToggle)).toBe(true);

  const firstReply = display(runtimeMessages.slice(0, 5));
  expect(JSON.stringify(firstReply)).not.toContain("Header spacing task");
  expect(firstReply.at(-1)).toMatchObject({
    detailsToggle: { sectionKey: "turn:146845", expanded: false },
  });

  const delivered = display(runtimeMessages, { isStreaming: true });
  expect(JSON.stringify(delivered)).not.toContain("Header spacing task");
  expect(JSON.stringify(delivered)).toContain("Spacing deployed");
  const finished = display(runtimeMessages);
  expect(JSON.stringify(finished)).not.toContain("Header spacing task");
  expect(JSON.stringify(finished)).not.toContain("Spacing deployed");
  expect(finished.filter((entry) => entry.kind === "message" && entry.detailsToggle)).toHaveLength(
    2,
  );
});

test("manual expansion and always-show preference retain the completed launch details", () => {
  const manual = display(runtimeMessages, { openDetailsSectionKey: "turn:146845" });
  expect(JSON.stringify(manual)).toContain("Header spacing task");
  expect(manual.at(-1)).toMatchObject({ detailsToggle: { expanded: false } });
  const always = display(runtimeMessages, { alwaysShowDetails: true });
  expect(JSON.stringify(always)).toContain("Header spacing task");
  expect(always.every((entry) => entry.kind === "message" && !entry.detailsToggle)).toBe(true);
});

test("consecutive runtime notices during unfinished work share its final reply control", () => {
  const messages = [
    runtimeMessages[3]!,
    runtimeMessages[1]!,
    { ...runtimeMessages[3]!, id: "steer", text: "Steering update" },
    runtimeMessages[4]!,
  ];
  expect(JSON.stringify(display(messages))).not.toContain("Header spacing task");
  expect(display(messages).at(-1)).toMatchObject({
    detailsToggle: { sectionKey: "turn:146870", expanded: false },
  });
});

const runtimeNotice = runtimeMessages[3]! as Extract<UiMessage, { role: "custom" }>;
const runtimeReply = runtimeMessages[4]! as Extract<UiMessage, { role: "assistant" }>;

function directReply(id: string, text: string): UiMessage {
  return {
    id,
    role: "assistant",
    timestamp: Number(id),
    turnPhase: "final",
    blocks: [{ type: "text", text }],
    directDelivery: { sessionId: `worker-${id}`, runId: `run-${id}` },
  };
}

// Reproduces the main transcript around entries 596053–596749: a normal
// heartbeat reply, a silent report, two direct Garmin results, another report.
test("direct cron outputs own their controls instead of inheriting heartbeat details", () => {
  const messages: UiMessage[] = [
    runtimeMessages[3]!,
    {
      ...runtimeReply,
      id: "mouse",
      blocks: [
        { type: "thinking", thinking: "Mouse reasoning" },
        { type: "text", text: "Museboet er ryddet" },
      ],
    },
    { ...runtimeNotice, id: "gps", text: "GPS report" },
    { ...runtimeReply, id: "silent", blocks: [{ type: "text", text: "NO_REPLY" }] },
    directReply("596412", "3,26 km i Fur"),
    directReply("596736", "Et friskt sødyp i Fur"),
    { ...runtimeNotice, id: "later", text: "Later report" },
    { ...runtimeReply, id: "silent2", blocks: [{ type: "text", text: "NO_REPLY" }] },
  ];
  const closed = display(messages);
  const replies = closed
    .filter((entry) => entry.kind === "message")
    .filter((entry) => entry.entry.message.role === "assistant");
  expect(replies.map((entry) => entry.detailsToggle?.sectionKey)).toEqual([
    "turn:146870",
    "turn:596412",
    "turn:596736",
  ]);
  const runOpen = display(messages, { openDetailsSectionKey: "turn:596412" });
  expect(JSON.stringify(runOpen)).toContain('"sessionId":"worker-596412"');
  expect(
    runOpen.some(
      (entry) => entry.kind === "message" && entry.entry.message.id === "596736:delivery",
    ),
  ).toBe(false);
  expect(JSON.stringify(runOpen)).not.toContain("Mouse reasoning");
  expect(JSON.stringify(runOpen)).not.toContain("GPS report");
  expect(JSON.stringify(runOpen)).not.toContain("Later report");
  const mouseOpen = display(messages, { openDetailsSectionKey: "turn:146870" });
  expect(JSON.stringify(mouseOpen)).toContain("Mouse reasoning");
  expect(JSON.stringify(mouseOpen)).not.toContain("GPS report");
  expect(
    mouseOpen.some(
      (entry) => entry.kind === "message" && entry.entry.message.id === "596412:delivery",
    ),
  ).toBe(false);
});

test.each(["cron", "subagent"])(
  "direct delivery during %s work does not steal its tools, attachments or final reply",
  (kind) => {
    const messages: UiMessage[] = [
      { ...runtimeNotice, customType: `batty-runtime-notice:${kind}` },
      runtimeMessages[1]!,
      {
        id: "attach-result",
        role: "toolResult",
        timestamp: 3,
        toolCallId: "attachment",
        toolName: "attach_files",
        isError: false,
        blocks: [],
        details: {
          sentFiles: [
            {
              id: "file",
              name: "result.txt",
              size: 1,
              mimeType: "text/plain",
              kind: "file",
              downloadUrl: "/file",
            },
          ],
        },
      },
      directReply("596412", "Direct result"),
      runtimeMessages[4]!,
    ];
    const closed = display(messages);
    const replies = closed
      .filter((entry) => entry.kind === "message")
      .filter((entry) => entry.entry.message.role === "assistant");
    expect(replies.map((entry) => entry.detailsToggle?.sectionKey)).toEqual([
      "turn:596412",
      "turn:146870",
    ]);
    expect(JSON.stringify(replies[0])).not.toContain("attachment");
    expect(JSON.stringify(replies[1])).toContain("attachment");
    const open = display(messages, { openDetailsSectionKey: "turn:146870" });
    expect(JSON.stringify(open)).toContain("Header spacing task");
    expect(
      open.filter((entry) => entry.kind === "message").map((entry) => entry.entry.message.id),
    ).toEqual(["146870", "146855", "596412", "146874"]);
    const running = display(messages.slice(0, -1), { isStreaming: true });
    expect(JSON.stringify(running)).toContain("Header spacing task");
    expect(
      running.find((entry) => entry.kind === "message" && entry.entry.message.id === "596412"),
    ).toMatchObject({
      detailsToggle: { sectionKey: "turn:596412", expanded: false },
    });
  },
);

test("always-show details includes each direct delivery's source session", () => {
  const entries = display([directReply("596412", "Direct result")], { alwaysShowDetails: true });
  expect(entries.map((entry) => entry.kind === "message" && entry.entry.message.id)).toEqual([
    "596412:delivery",
    "596412",
  ]);
  expect(JSON.stringify(entries)).toContain('"sessionId":"worker-596412"');
});
