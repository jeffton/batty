import { describe, expect, it } from "vite-plus/test";
import { parseClientMessageId } from "./sessions";

describe("parseClientMessageId", () => {
  it("accepts UUID client message IDs", () => {
    const id = crypto.randomUUID();
    expect(parseClientMessageId(id)).toBe(id);
  });

  it.each([undefined, "", "not-a-uuid"])("rejects invalid client message ID %s", (value) => {
    expect(() => parseClientMessageId(value)).toThrow("A valid clientMessageId is required");
  });
});
