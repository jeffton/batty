import { expect, test } from "vite-plus/test";
import type { JsonValue } from "@earendil-works/chord/json";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { fileLibraryRef, siteLibraryRef } from "@/shared/artifact-library";
import { decodeRuntimeNotice } from "./runtime-notices";
import { entryMessages } from "./runtime";
import { fixture, until, withAttachments } from "./orchestration-test-fixture";
import { orchestrationHistory } from "./orchestration-test-history";

const file = {
  id: "report-file",
  name: "report.png",
  storedPath: "/tmp/report.png",
  size: 1,
  mimeType: "image/png",
  kind: "image" as const,
  downloadUrl: "/api/sent-files/report-file",
};
const site = {
  kind: "site" as const,
  id: "report-site",
  name: "Report site",
  url: "/site",
  public: false as const,
};
const browser = {
  kind: "browser" as const,
  id: "report-browser",
  browserId: "same-live-browser",
  name: "Browser",
  url: "/browser",
  public: false as const,
};
const artifacts = { sentFiles: [file], sites: [site, browser] };
const fileRef = fileLibraryRef(file.id);
const siteRef = siteLibraryRef(site.id);
const browserId = browser.browserId;

test.each([false, true])(
  "nonterminal report selects attachments only for the actual parent (nested=%s)",
  async (nested) => {
    const { faux, orchestration, open, registry } = await fixture(
      10_000,
      console.error,
      "other",
      undefined,
      async (_, selection) => {
        expect(selection.browserId).toBe(browserId);
        if (selection.artifactRefs) {
          expect(selection.artifactRefs).toEqual([fileRef, siteRef]);
          return artifacts;
        }
        return { sites: [browser] };
      },
    );
    let release!: () => void;
    let continued = false;
    let progressInput = "";
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    registry.install(
      defineExtension({
        name: "progress-fixture",
        tools: [
          defineTool({
            name: "continue-working",
            description: "Continue after reporting",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async (_, __, ctx) => {
              continued = true;
              await new Promise<void>((resolve, reject) => {
                const abort = () => reject(ctx.abortSignal!.reason);
                ctx.abortSignal!.addEventListener("abort", abort, { once: true });
                void gate.then(() => {
                  ctx.abortSignal!.removeEventListener("abort", abort);
                  resolve();
                });
              });
              return { output: [{ type: "text", text: "continued work complete" }] };
            },
          }),
        ],
      }),
    );
    const { harness, main } = await open();
    const call = (name: string, args: Record<string, JsonValue>) =>
      fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
    faux.setResponses(
      Array.from({ length: 40 }, () => (request) => {
        const last = request.messages.findLast((m) => m.role !== "system")!;
        const text = JSON.stringify(last.content);
        if (last.role === "user" && text.includes("launch progress"))
          return call("subagent", {
            action: "run",
            prompt: nested ? "outer assignment" : "inner assignment",
            workspaceId: "other",
          });
        if (last.role === "user" && text.includes("outer assignment"))
          return call("subagent", {
            action: "run",
            prompt: "inner assignment",
            workspaceId: "test",
          });
        if (last.role === "user" && text.includes("inner assignment"))
          return call("subagent", {
            action: "report",
            prompt: "intermediate evidence",
            artifactRefs: [fileRef, siteRef],
            browserId,
          });
        if (last.role === "toolResult" && text.includes("Reported to parent"))
          return call("continue-working", {});
        if (last.role === "toolResult" && last.toolName === "continue-working")
          return fauxAssistantMessage([fauxText("inner final")]);
        if (last.role === "user" && text.includes("intermediate evidence")) {
          progressInput = text;
          return fauxAssistantMessage([
            fauxText(
              nested
                ? "progress acknowledged"
                : withAttachments("progress acknowledged", { browserId }),
            ),
          ]);
        }
        if (
          last.role === "toolResult" &&
          text.includes("Started. Session ID:") &&
          nested &&
          request.messages.some(
            (m) => m.role === "user" && JSON.stringify(m.content).includes("outer assignment"),
          )
        )
          return call("subagent", {
            action: "await",
            sessionId: text.match(/Session ID: (\d+)/)![1]!,
          });
        if (text.includes("inner final")) return fauxAssistantMessage([fauxText("outer final")]);
        return fauxAssistantMessage([fauxText("acknowledged")]);
      }),
    );
    try {
      await (
        await main.submit({ type: "input", content: "launch progress" }, context)
      ).wait(context);
      await until(async () => continued && progressInput.includes(siteRef));
      expect(progressInput).toContain(fileRef);
      const state = (await orchestrationHistory(harness))!;
      const child = Object.values(state.workers).find(
        (worker) => worker.prompt === "inner assignment",
      )!;
      expect((await harness.getTask(child.active!, context))!.state.status).not.toBe("terminal");
      const parent = (await harness.conversation(child.parentId, context))!;
      const notices = (await parent.context(context)).messages.flatMap((message) =>
        message.role === "user" ? [decodeRuntimeNotice(message.content)] : [],
      );
      const progress = notices.filter((notice) =>
        notice?.text.startsWith(`[subagent ${child.id} report]`),
      );
      expect(progress).toHaveLength(1);
      expect(progress[0]!.data!.runtimePresentation).toEqual(artifacts);
      if (nested) {
        expect(JSON.stringify((await main.context(context)).messages)).not.toContain(
          "intermediate evidence",
        );
        expect(child.workspaceId).toBe("test");
        expect(
          Object.values(state.workers).find((worker) => worker.id === child.parentId)!.workspaceId,
        ).toBe("other");
      }
    } finally {
      release();
    }
    await until(async () => (await orchestration.listRunning()).length === 0);
    await main.waitForIdle(context);
    const { entries, messages } = await main.context(context);
    const final = messages
      .flatMap((message) => (message.role === "user" ? [decodeRuntimeNotice(message.content)] : []))
      .find((notice) => notice?.text.includes(nested ? "outer final" : "inner final"));
    expect(final).toBeDefined();
    expect(final?.data?.runtimePresentation).toBeUndefined();
    const replies = entryMessages(entries).filter((message) => message.role === "assistant");
    expect(replies.flatMap((message) => message.sites ?? [])).toEqual(nested ? [] : [browser]);
    expect(replies.flatMap((message) => message.sentFiles ?? [])).toEqual([]);
  },
);

test("main cannot send a report or select an arbitrary recipient", async () => {
  const { faux, open } = await fixture();
  const { main } = await open();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("subagent", { action: "report", prompt: "invalid" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(
      [fauxToolCall("subagent", { action: "report", prompt: "invalid", sessionId: "123" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("done")]),
  ]);
  await (
    await main.submit({ type: "input", content: "try invalid report" }, context)
  ).wait(context);
  const messages = JSON.stringify((await main.context(context)).messages);
  expect(messages).toContain("Only an assigned subagent");
  expect(messages).toContain("omit sessionId");
  expect(messages).not.toContain("[subagent");
});
