import { describe, expect, it } from "vite-plus/test";
import { createAuthToken, verifyAuthToken } from "@/server/auth";

describe("auth tokens", () => {
  it("accepts valid tokens", () => {
    const token = createAuthToken("secret", 10_000);
    expect(verifyAuthToken("secret", token)).toBe(true);
  });

  it("rejects tampered tokens", () => {
    const token = createAuthToken("secret", 10_000);
    expect(verifyAuthToken("secret", `${token}tampered`)).toBe(false);
  });
});
