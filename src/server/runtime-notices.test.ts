import { expect, test } from "vite-plus/test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { normalizeMessage } from "./pi-state";
import { projectEntry } from "./memory";
import {
  buildCronRuntimeNotice,
  decodeRuntimeNotice,
  encodeRuntimeNotice,
} from "./runtime-notices";

test.each([false, true])(
  "runtime reports retain blue notice metadata and memory classification (blocks=%s)",
  (blocks) => {
    const notice = {
      kind: "subagent" as const,
      text: "Worker result\nDone",
      data: {
        runtimeNotice: { text: "Worker result", markdown: "Done" },
        subagent: { sessionId: "42", prompt: "Assigned task" },
      },
    };
    const encoded = encodeRuntimeNotice(notice);
    const message = {
      role: "user",
      content: blocks ? [{ type: "text", text: encoded }] : encoded,
      timestamp: 1000,
    } as AgentMessage;
    expect(decodeRuntimeNotice(blocks ? [{ type: "text", text: encoded }] : encoded)).toEqual(
      notice,
    );
    expect(normalizeMessage(message, 0)).toMatchObject({
      role: "custom",
      customType: "batty-runtime-notice:subagent",
      text: notice.text,
      data: notice.data,
    });
    expect(
      projectEntry({ id: 9, kind: "pi.user", model: [message] } as unknown as EntryRecord),
    ).toMatchObject([{ kind: "note", text: "Runtime subagent: Worker result\nDone" }]);
  },
);

test.each([
  "<batty-runtime-notice>hello</batty-runtime-notice>",
  "<batty-runtime-notice>null</batty-runtime-notice>",
  '<batty-runtime-notice>{"kind":"subagent"}</batty-runtime-notice>',
])("literal malformed notice remains user text: %s", (content) => {
  expect(decodeRuntimeNotice(content)).toBeUndefined();
  expect(normalizeMessage({ role: "user", content, timestamp: 1000 }, 0)).toMatchObject({
    role: "user",
  });
});

test("cron notice describes the separate scheduled worker scope", () => {
  const notice = buildCronRuntimeNotice({
    scheduleLabel: "hourly",
    prompt: "Do the scheduled task",
  });
  expect(notice.text).toContain("Assigned scheduled task:\nDo the scheduled task");
  expect(notice.text).toContain("not the main assistant");
  expect(notice.text).not.toContain("NO_REPLY");
});
