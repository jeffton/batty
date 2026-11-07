import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type EntryRecord } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { artifactRefs, reportWithArtifacts } from "./artifact-forwarding";
import { runtimeResultArtifacts } from "./runtime-result-artifacts";
import {
  decodeRuntimeNotice,
  encodeRuntimeNotice,
  projectRuntimeNoticeRequest,
} from "./runtime-notices";

function report() {
  const body = "private-diff-body ".repeat(120_000);
  const artifacts = {
    fileChanges: [{ path: "/workspace/file.ts", patch: body }],
    battyFileChanges: [{ path: "/workspace/other.ts", before: body, after: `${body}changed` }],
  };
  const text = reportWithArtifacts("Worker done", artifacts);
  return {
    artifacts,
    text,
    content: encodeRuntimeNotice({
      kind: "subagent",
      text,
      data: { runtimeResultArtifacts: artifacts },
    }),
  };
}

test("new report projection keeps refs and images while durable attachment bodies remain resolvable", () => {
  const { artifacts, text, content } = report();
  const image = { type: "image" as const, data: "image-bytes", mimeType: "image/png" };
  const message = {
    role: "user" as const,
    content: [{ type: "text" as const, text: content }, image],
    timestamp: 1,
  };
  const projected = projectRuntimeNoticeRequest({ messages: [message] });
  expect(projected.messages[0]).toEqual({ ...message, content: [{ type: "text", text }, image] });
  expect((projected.messages[0]!.content as unknown[])[1]).toBe(image);
  expect(decodeRuntimeNotice(message.content)?.data?.runtimeResultArtifacts).toEqual(artifacts);
  const recovered = runtimeResultArtifacts([{ model: [message] } as unknown as EntryRecord]);
  expect(artifactRefs(recovered).map(({ ref }) => ref)).toContain(artifactRefs(artifacts)[0]!.ref);
  expect(recovered.fileChanges).toContainEqual(artifacts.fileChanges[0]);
});

test("embedded historical reports project independently without treating a marker inside JSON as its end", () => {
  const literal = "A literal </batty-runtime-notice> in the report";
  const first = encodeRuntimeNotice({
    kind: "subagent",
    text: literal,
    data: { body: "not-model-content" },
  });
  const second = report();
  const content = `[User]: ${first}\n\n[User]: ${second.content}\n\n[Assistant]: Continue`;
  const request = { messages: [{ role: "user" as const, content, timestamp: 1 }] };
  expect(projectRuntimeNoticeRequest(request).messages[0]!.content).toBe(
    `[User]: ${literal}\n\n[User]: ${second.text}\n\n[Assistant]: Continue`,
  );
  expect(request.messages[0]!.content).toBe(content);
  const malformed = "<batty-runtime-notice>not json</batty-runtime-notice>";
  expect(
    projectRuntimeNoticeRequest({ messages: [{ role: "user", content: malformed, timestamp: 1 }] })
      .messages[0]!.content,
  ).toBe(malformed);
});

test("generation and native compaction exclude historical multi-megabyte artifact bodies without rewriting history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "batty-notice-provider-"));
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "tiny", contextWindow: 4096, maxTokens: 1024 }] });
  models.setProvider(faux.provider);
  const streamSimple = models.streamSimple.bind(models);
  models.streamSimple = (model, request, options) =>
    streamSimple(model, projectRuntimeNoticeRequest(request), options);
  const requests: string[] = [];
  faux.setResponses(
    Array.from({ length: 20 }, () => (request: Parameters<typeof models.streamSimple>[1]) => {
      requests.push(JSON.stringify(request.messages));
      return fauxAssistantMessage("Checkpoint done");
    }),
  );
  const storage = await openNodeSqliteStorage(join(directory, "runtime.sqlite"));
  const harness = await Harness.open(
    storage,
    {
      models,
      registry: createRegistry(),
      settings: {
        compaction: {
          enabled: true,
          reserveTokens: 1024,
          keepRecentTokens: 64,
          backgroundTokens: 0,
        },
      },
    },
    context,
  );
  try {
    const worker = await harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "tiny" } } },
      context,
    );
    const { content, text, artifacts } = report();
    await worker.commit(async (tx) => {
      await tx.appendEntry(worker.id, {
        kind: "pi.user",
        model: [{ role: "user", content, timestamp: 1 }],
      });
      await tx.appendEntry(worker.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "Recent input ".repeat(100), timestamp: 2 }],
      });
    }, context);
    await harness.waitForTask(await worker.compact(undefined, context), context);
    expect(requests.some((request) => request.includes("context summarization assistant"))).toBe(
      true,
    );
    expect(requests[0]).toContain("Worker done");
    expect(requests[0]).toContain(artifactRefs(artifacts)[0]!.ref);
    const result = await (await worker.submit({ type: "input", content }, context)).wait(context);
    expect(result.status).toBe("done");
    expect(requests.at(-1)).toContain(text.split("\n")[0]!);
    expect(requests.every((request) => !request.includes("private-diff-body"))).toBe(true);
    const stored = (await worker.entries({}, 100, undefined, context)).items;
    const originalReports = stored
      .flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "user" && message.content === content);
    expect(originalReports).toHaveLength(2);
    expect(decodeRuntimeNotice(originalReports[0]!.content)?.data?.runtimeResultArtifacts).toEqual(
      artifacts,
    );
  } finally {
    await harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});
