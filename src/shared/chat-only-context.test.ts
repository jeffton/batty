import { describe, expect, it } from "vite-plus/test";
import { chatOnlyBlocks } from "./chat-only-context";

describe("chat-only transcript policy", () => {
  it("empty assistant text is not chat, while attachments and actual replies survive", () => {
    expect(chatOnlyBlocks("assistant", [{ type: "text", text: "" }])).toBeUndefined();
    expect(chatOnlyBlocks("assistant", [{ type: "text", text: " \n\t" }])).toBeUndefined();
    const image = { type: "image", url: "/image.png" };
    expect(chatOnlyBlocks("assistant", [{ type: "text", text: "" }, image])).toEqual([image]);
    expect(chatOnlyBlocks("assistant", [{ type: "text", text: " Answer " }])).toEqual([
      { type: "text", text: " Answer " },
    ]);
  });

  it("keeps user chat and strips assistant transcript details", () => {
    const user = [{ type: "text", text: "Question" }];
    expect(chatOnlyBlocks("user", user)).toEqual(user);
    expect(
      chatOnlyBlocks("assistant", [
        { type: "thinking", thinking: "secret" },
        { type: "text", text: "Answer" },
        { type: "toolCall", id: "call-1" },
      ]),
    ).toEqual([{ type: "text", text: "Answer" }]);
    expect(chatOnlyBlocks("toolResult", [{ type: "text", text: "output" }])).toBeUndefined();
    expect(chatOnlyBlocks("assistant", [{ type: "text", text: "NO_REPLY" }])).toBeUndefined();
  });
});
