import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { attachmentText, extractSelection } from "./message-presentation";
import { fixture, withAttachments } from "./orchestration-test-fixture";
import type { SentFileDescriptor } from "@/shared/types";

const proof = {
  id: "proof",
  name: "Proof.txt",
  downloadUrl: "/api/sent-files/proof",
  size: 3,
  mimeType: "text/plain",
  kind: "file",
} satisfies SentFileDescriptor;

test("attachment envelopes are suppressed during streaming, even when the marker is split", () => {
  const signed = withAttachments("Done", { artifactRefs: ["file:proof"] });
  for (let length = "Done\n\n<".length; length <= signed.length; length++)
    expect(attachmentText(signed.slice(0, length))).toBe("Done");
  expect(attachmentText("Ordinary \n\nparagraph")).toBe("Ordinary \n\nparagraph");
});

test("literal metadata examples and earlier assistant text are not interpreted as selections", () => {
  const example = withAttachments("Example:", { artifactRefs: ["file:proof"] });
  const fenced = `Example:\n\n\`\`\`text\n${example}\n\`\`\`\n\nMore instructions.`;
  const exampleMessage = fauxAssistantMessage(fenced);
  expect(extractSelection(exampleMessage)).toBeUndefined();
  expect(exampleMessage.content).toEqual([fauxText(fenced)]);
  expect(attachmentText(fenced)).toBe(fenced);
  const prose = fauxAssistantMessage([fauxText(example), fauxText("After the example")]);
  expect(extractSelection(prose)).toBeUndefined();
  expect(prose.content).toEqual([fauxText(example), fauxText("After the example")]);
});

test("persisted interim and final assistant messages carry only their own selections", async () => {
  const { faux, registry, open } = await fixture(
    undefined,
    undefined,
    undefined,
    undefined,
    async (_conversation, selection) => {
      expect(selection).toEqual({ artifactRefs: ["file:proof"] });
      return { sentFiles: [proof] };
    },
  );
  registry.install(
    defineExtension({
      name: "presentation-test",
      tools: [
        defineTool({
          name: "work",
          description: "Continue after an interim delivery",
          parameters: Type.Object({}),
          execute: async () => ({ output: [fauxText("work complete")] }),
        }),
      ],
    }),
  );
  let { main, harness } = await open();
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxText(withAttachments("Interim text", { artifactRefs: ["file:proof"] })),
        fauxToolCall("work", {}),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Final text"),
    fauxAssistantMessage(
      'Bad metadata\n\n<batty-attachments>{"notSupported":true}</batty-attachments>',
    ),
  ]);
  await (await main.submit({ type: "input", content: "Start" }, context)).wait(context);
  await (await main.submit({ type: "input", content: "Try invalid" }, context)).wait(context);
  await harness.close(context);
  ({ main } = await open());
  const replies = (await main.context(context)).entries.flatMap((entry) =>
    (entry.model ?? []).filter((message) => message.role === "assistant"),
  );
  expect(replies).toHaveLength(3);
  expect(replies[0]).toMatchObject({
    battyPresentation: { sentFiles: [proof] },
    content: [
      { type: "text", text: "Interim text" },
      { type: "toolCall", name: "work" },
    ],
  });
  expect(replies[1]).toMatchObject({ content: [{ type: "text", text: "Final text" }] });
  expect(replies[1]).not.toHaveProperty("battyPresentation");
  expect(replies[2]).not.toHaveProperty("battyPresentation");
  expect(replies[2]).toMatchObject({
    content: [
      { type: "text", text: "Bad metadata" },
      {
        type: "text",
        text: "\n\nAttachment selection failed: Invalid message attachment metadata",
      },
    ],
  });
});
