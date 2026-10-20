import { expect, test } from "vite-plus/test";
import { queuedPromptDisplay } from "./queued-prompt-display";
import { buildCronRuntimeNotice, encodeRuntimeNotice } from "./runtime-notices";

test.each(["cron", "subagent"] as const)(
  "queued %s reports display their result, not the envelope",
  (kind) => {
    const content = encodeRuntimeNotice({
      kind,
      text: "Internal routing instruction",
      data: {
        runtimeNotice: {
          text: "Task result",
          markdown: "Completed report with [artifact](https://example.com).",
        },
        [kind]: { sessionId: "42", prompt: "Internal assigned prompt" },
        runtimeResultArtifacts: { sentFiles: [{ name: "report.txt" }] },
      },
    });
    const display = queuedPromptDisplay([{ type: "text", text: content }]);
    expect(display).toEqual({
      runtimeNoticeKind: kind,
      text: "Task result\nCompleted report with [artifact](https://example.com).",
    });
    expect(content).toContain("runtimeResultArtifacts");
    expect(content).toContain("Internal assigned prompt");
  },
);

test("scheduled task notices do not expose execution instructions", () => {
  const content = encodeRuntimeNotice(
    buildCronRuntimeNotice({
      prompt: "Private scheduled prompt",
      scheduleLabel: "hourly",
    }),
  );
  expect(queuedPromptDisplay(content)).toEqual({
    runtimeNoticeKind: "cron",
    text: "Scheduled task",
  });
});

test("ordinary queued text and malformed envelopes remain user messages", () => {
  expect(queuedPromptDisplay("Hello")).toEqual({ text: "Hello" });
  expect(queuedPromptDisplay([{ type: "text", text: "Hello" }, { type: "image" }])).toEqual({
    text: "Hello",
  });
  const malformed = "<batty-runtime-notice>not json</batty-runtime-notice>";
  expect(queuedPromptDisplay(malformed)).toEqual({ text: malformed });
});
