import { describe, expect, it } from "vite-plus/test";
import {
  isWithinWorkingHours,
  normalizeWorkingHours,
  workingHoursDateKey,
  type WorkingHours,
} from "./working-hours";

const weekdays: WorkingHours = {
  timeZone: "Europe/Stockholm",
  days: [1, 2, 3, 4, 5],
  start: "08:00",
  end: "16:00",
};

describe("working hours", () => {
  it.each([
    ["2026-11-16T06:59:59Z", false],
    ["2026-11-16T07:00:00Z", true],
    ["2026-11-16T14:59:59Z", true],
    ["2026-11-16T15:00:00Z", false],
    ["2026-11-21T10:00:00Z", false],
    ["2026-07-20T06:00:00Z", true],
    ["2026-07-20T14:00:00Z", false],
  ])("uses zone-local weekdays and half-open boundaries at %s", (instant, expected) => {
    expect(isWithinWorkingHours(weekdays, new Date(instant))).toBe(expected);
  });

  it("is unrestricted when the option is omitted", () => {
    expect(isWithinWorkingHours(undefined, new Date("2026-11-22T23:00:00Z"))).toBe(true);
  });

  it.each([
    ["2026-11-20T20:59:59Z", false],
    ["2026-11-20T21:00:00Z", true],
    ["2026-11-21T00:59:59Z", true],
    ["2026-11-21T01:00:00Z", false],
    ["2026-11-21T21:00:00Z", false],
    ["2026-11-23T00:00:00Z", false],
  ])("anchors overnight windows to the start weekday at %s", (instant, expected) => {
    expect(
      isWithinWorkingHours(
        { ...weekdays, days: [5], start: "22:00", end: "02:00" },
        new Date(instant),
      ),
    ).toBe(expected);
  });

  it("wraps Sunday overnight into Monday", () => {
    expect(
      isWithinWorkingHours(
        { ...weekdays, days: [7], start: "22:00", end: "02:00" },
        new Date("2026-11-23T00:30:00Z"),
      ),
    ).toBe(true);
  });

  it("uses wall-clock boundaries through spring-forward and repeated autumn hours", () => {
    const sunday = { ...weekdays, days: [7], start: "02:30", end: "03:30" };
    expect(isWithinWorkingHours(sunday, new Date("2026-03-29T00:59:59Z"))).toBe(false);
    expect(isWithinWorkingHours(sunday, new Date("2026-03-29T01:00:00Z"))).toBe(true);
    expect(isWithinWorkingHours(sunday, new Date("2026-03-29T01:30:00Z"))).toBe(false);
    expect(isWithinWorkingHours(sunday, new Date("2026-10-25T00:45:00Z"))).toBe(true);
    expect(isWithinWorkingHours(sunday, new Date("2026-10-25T01:45:00Z"))).toBe(true);
    expect(isWithinWorkingHours(sunday, new Date("2026-10-25T02:30:00Z"))).toBe(false);
  });

  it("keys the actual local calendar date, including after midnight overnight", () => {
    expect(workingHoursDateKey(weekdays, new Date("2026-11-16T23:30:00Z"))).toBe("2026-11-17");
    expect(workingHoursDateKey(weekdays, new Date("2026-07-20T22:30:00Z"))).toBe("2026-07-21");
  });

  it.each([
    null,
    false,
    [],
    {},
    { ...weekdays, timeZone: "Europe/Imaginary" },
    { ...weekdays, timeZone: "+01:00" },
    { ...weekdays, timeZone: "EST" },
    { ...weekdays, days: [] },
    { ...weekdays, days: [0] },
    { ...weekdays, days: [8] },
    { ...weekdays, days: [1.5] },
    { ...weekdays, days: ["1"] },
    { ...weekdays, days: [1, 1] },
    { ...weekdays, start: "8:00" },
    { ...weekdays, start: "24:00" },
    { ...weekdays, end: "16:60" },
    { ...weekdays, end: "08:00" },
    { ...weekdays, enabled: false },
  ])("rejects malformed configuration %j", (candidate) => {
    expect(() => normalizeWorkingHours(candidate)).toThrow("Invalid workingHours");
  });
});
