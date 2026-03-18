import { describe, expect, it } from "vite-plus/test";
import { createLoginRateLimiter } from "@/server/login-rate-limit";

describe("createLoginRateLimiter", () => {
  it("blocks after five failed attempts inside the window", () => {
    const limiter = createLoginRateLimiter(5, 60_000);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(limiter.isLimited("127.0.0.1", attempt * 1_000)).toBe(false);
      limiter.recordFailure("127.0.0.1", attempt * 1_000);
    }

    expect(limiter.isLimited("127.0.0.1", 5_000)).toBe(true);
  });

  it("allows attempts again after the window expires", () => {
    const limiter = createLoginRateLimiter(5, 60_000);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      limiter.recordFailure("127.0.0.1", attempt * 1_000);
    }

    expect(limiter.isLimited("127.0.0.1", 60_001)).toBe(false);
  });

  it("clears failures after a successful login", () => {
    const limiter = createLoginRateLimiter(5, 60_000);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      limiter.recordFailure("127.0.0.1", attempt * 1_000);
    }

    limiter.reset("127.0.0.1");

    expect(limiter.isLimited("127.0.0.1", 5_000)).toBe(false);
  });
});
