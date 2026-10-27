import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ImageContent } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { fixture, cleanup } from "./memory-test-fixture";

const image: ImageContent = {
  type: "image",
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBzQAAAAASUVORK5CYII=",
};

test("leaf zoom retrieves only the selected archived message's images without polluting memory views", async () => {
  const f = await fixture();
  let state = await f.open({ viewBytes: 10_000 });
  await state.main.commit(
    (tx) =>
      tx.appendEntry(state.main.id, {
        kind: "pi.user",
        model: [
          { role: "system", content: "instructions", timestamp: 1 },
          fauxAssistantMessage([
            { type: "thinking", thinking: "private reasoning" },
            fauxText("look at screenshot"),
            fauxToolCall("read", { path: "screenshot.png" }),
          ]),
          {
            role: "toolResult",
            toolCallId: "read-image",
            toolName: "read",
            content: [{ type: "text", text: "screenshot" }, image],
            isError: false,
            timestamp: 2,
          },
          {
            role: "user",
            content: [{ type: "text", text: "two screenshots" }, image, image],
            timestamp: 3,
          },
          { role: "user", content: "plain text", timestamp: 4 },
        ],
      }),
    context,
  );
  const overview = await state.memory.prepare();
  expect(overview).toContain("[image image/png]");
  expect(overview).not.toContain(image.data);
  expect(overview).not.toContain("private reasoning");
  // Retrieval must work from the persisted archive, not just this process's input.
  await state.memory.close();
  await state.harness.close(context);
  state = await f.open({ viewBytes: 10_000 });
  cleanup.push(async () => {
    await state.memory.close();
    await state.harness.close(context);
  });
  const cases = [
    {
      id: 0,
      n: 1,
      images: [],
      text: `0+0|[${await state.memory.date(0)}] talk: look at screenshot`,
    },
    {
      id: 1,
      n: 1,
      images: [],
      text: `1+0|[${await state.memory.date(1)}] tool: read {"path":"screenshot.png"}`,
    },
    {
      id: 2,
      n: 1,
      images: [image],
      text: "2+0|[1970-01-01T00:00:00.002Z] echo: screenshot\n[image]",
    },
    {
      id: 3,
      n: 1,
      images: [image, image],
      text: "3+0|[1970-01-01T00:00:00.003Z] user: two screenshots\n[image image/png]\n[image image/png]",
    },
    { id: 4, n: 1, images: [], text: "4+0|[1970-01-01T00:00:00.004Z] user: plain text" },
    { id: 2, n: 2, images: [], text: await state.memory.zoom(2, 2) },
  ];
  f.faux.setResponses(
    cases.flatMap(({ id, n, images, text }) => [
      () =>
        fauxAssistantMessage([fauxToolCall("memory_zoom", { id, n })], {
          stopReason: "toolUse",
        }),
      (request) => {
        const result = request.messages.findLast((message) => message.role === "toolResult")!;
        expect(result.role).toBe("toolResult");
        if (result.role !== "toolResult") throw new Error("Missing zoom result");
        expect(result.isError).toBe(false);
        expect(result.content).toEqual([{ type: "text", text }, ...images]);
        expect(JSON.stringify(result)).not.toContain("private reasoning");
        return fauxAssistantMessage([fauxText("done")]);
      },
    ]),
  );
  for (const { id, n } of cases) {
    const submission = await state.main.submit(
      { type: "input", content: `Inspect ${id}+${n}` },
      context,
    );
    expect((await submission.wait(context)).status).toBe("done");
  }
});
