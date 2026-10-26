import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { Message } from "@earendil-works/pi-ai";
import { loadConfig } from "./config";
import { Runtime, context } from "./runtime";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "batty-queue-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  vi.stubEnv("PI_OFFLINE", "1");
  await mkdir(join(directory, ".batty"));
  await mkdir(join(directory, "work"));
  await writeFile(
    join(directory, ".batty/options.json"),
    JSON.stringify({
      workspacesRoots: [directory],
      webPushSubject: "mailto:test@example.com",
    }),
  );
  const config = {
    ...(await loadConfig(directory)),
    selfPath: join(directory, "work"),
    defaultProvider: "faux",
    defaultModel: "queue-test",
    memoryModel: "faux/queue-test",
  };
  const faux = fauxProvider({ models: [{ id: "queue-test" }] });
  const runtime = await Runtime.open(config, {
    beforeStart: (opened) => opened.models.registerNativeProvider(faux.provider),
  });
  cleanup.push(() => runtime.close());
  return { runtime, faux };
}

function userTexts(messages: readonly Message[]) {
  return messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n"),
    );
}

for (const mode of ["followUp", "steer"] as const) {
  test(`pending ${mode} burst reaches the next eligible request together, in order`, async () => {
    const { runtime, faux } = await fixture();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // Release first even if an assertion fails, so shutdown can join the provider.
    cleanup.push(async () => {
      release.resolve();
    });
    const requests: string[][] = [];
    faux.setResponses([
      async (request) => {
        requests.push(userTexts(request.messages));
        started.resolve();
        await release.promise;
        return mode === "steer"
          ? fauxAssistantMessage([fauxToolCall("memory_search", { query: "noqueuehistory" })], {
              stopReason: "toolUse",
            })
          : fauxAssistantMessage([fauxText("first answer")]);
      },
      (request) => {
        requests.push(userTexts(request.messages));
        return fauxAssistantMessage([fauxText("burst answer")]);
      },
      (request) => {
        requests.push(userTexts(request.messages));
        return fauxAssistantMessage([fauxText("follow-up answer")]);
      },
    ]);
    const first = await runtime.main.submit({ type: "input", content: "start" }, context);
    await started.promise;
    const queued = [];
    for (const [index, text] of ["one", "two", "three"].entries()) {
      queued.push(
        await runtime.main.submit(
          {
            type: "input",
            content: text,
            requestId: `burst-${index}`,
            whenBusy: mode,
          },
          context,
        ),
      );
    }
    // Request IDs still deduplicate, and queued submissions remain independently removable.
    const duplicate = await runtime.main.submit(
      {
        type: "input",
        content: "two",
        requestId: "burst-1",
        whenBusy: mode,
      },
      context,
    );
    expect(duplicate.id).toBe(queued[1]!.id);
    const removed = await runtime.main.submit(
      { type: "input", content: "withdraw me", whenBusy: mode },
      context,
    );
    expect(await removed.abort(context)).toBe("aborted");
    const followUp =
      mode === "steer"
        ? await runtime.main.submit(
            { type: "input", content: "after final", whenBusy: "followUp" },
            context,
          )
        : undefined;
    expect((await runtime.state()).queuedPrompts!.map((prompt) => prompt.text)).toEqual([
      "one",
      "two",
      "three",
      ...(followUp ? ["after final"] : []),
    ]);
    release.resolve();
    const receipts = await Promise.all(
      [first, ...queued, ...(followUp ? [followUp] : [])].map((submission) =>
        submission.wait(context),
      ),
    );
    expect(receipts.map((receipt) => receipt.status)).toEqual(receipts.map(() => "done"));
    expect(new Set(queued.map((submission) => submission.id)).size).toBe(3);
    expect(requests).toHaveLength(followUp ? 3 : 2);
    expect(requests[1]!.slice(-3)).toEqual(["one", "two", "three"]);
    if (followUp) {
      expect(requests[1]).not.toContain("after final");
      expect(requests[2]!.at(-1)).toBe("after final");
    }
    const placed = await Promise.all(queued.map((submission) => submission.status(context)));
    expect(new Set(placed.map((receipt) => receipt.entry)).size).toBe(3);
    const entries = await Promise.all(
      placed.map((receipt) => runtime.storage.entry(runtime.main.id, receipt.entry!, context)),
    );
    expect(entries.flatMap((entry) => userTexts(entry!.entry.model as Message[]))).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect((await removed.status(context)).entry).toBeUndefined();
    expect((await runtime.state()).pendingMessageCount).toBe(0);
  });
}

test("a single idle message starts normally without a burst timer", async () => {
  const { runtime, faux } = await fixture();
  const requests: string[][] = [];
  faux.setResponses([
    (request) => {
      requests.push(userTexts(request.messages));
      return fauxAssistantMessage([fauxText("single answer")]);
    },
  ]);
  const submission = await runtime.main.submit({ type: "input", content: "single" }, context);
  expect((await submission.wait(context)).status).toBe("done");
  expect(requests).toHaveLength(1);
  expect(requests[0]!.at(-1)).toBe("single");
  expect((await runtime.state()).pendingMessageCount).toBe(0);
});
