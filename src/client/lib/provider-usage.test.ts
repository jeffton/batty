import { describe, expect, it } from "vite-plus/test";
import { usageWindowDisplay } from "./provider-usage";

const window = { id: "primary", usedPercent: 25, windowSeconds: 3600, resetsAt: 3600000 };

describe("usageWindowDisplay", () => {
  it.each([
    [25, "25% surplus"],
    [75, "25% in deficit"],
    [50, "On pace"],
    [50.4, "On pace"],
    [49.6, "On pace"],
  ])("describes %s percent used halfway through the window", (usedPercent, label) => {
    expect(usageWindowDisplay({ ...window, usedPercent }, 1800000).paceLabel).toBe(label);
  });

  it.each([
    [0, "0h 00m"],
    [5 * 60000, "0h 05m"],
    [(23 * 60 + 59) * 60000, "23h 59m"],
    [24 * 3600000, "1d 0h"],
    [49 * 3600000, "2d 1h"],
    [-60000, "0h 00m"],
  ])("formats reset after %s milliseconds", (resetsAt, duration) => {
    expect(usageWindowDisplay({ ...window, resetsAt }, 0).resetLabel).toBe(`Resets in ${duration}`);
  });
});
