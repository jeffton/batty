import { describe, expect, it } from "vite-plus/test";
import {
  buildDailyCronSessionBinding,
  CRON_RUN_SESSION_CUSTOM_TYPE,
  CRON_SESSION_CUSTOM_TYPE,
  findDailyCronSessionBinding,
  findLatestDailyCronSessionBinding,
  hasParentedCronRunSessionMarker,
  localDayStartMs,
  toLocalIsoDate,
} from "./cron-session";

describe("cron session helpers", () => {
  it("uses local time for daily session keys", () => {
    expect(toLocalIsoDate(new Date("2026-03-31T03:30:00Z"), "04:00")).toBe("2026-03-31");
  });

  it("keeps late-night runs on the previous day before the configured rollover", () => {
    expect(toLocalIsoDate(new Date("2026-03-31T01:30:00+02:00"), "04:00")).toBe("2026-03-30");
    expect(toLocalIsoDate(new Date("2026-03-31T04:00:00+02:00"), "04:00")).toBe("2026-03-31");
    expect(localDayStartMs(new Date("2026-03-31T01:30:00+02:00"), "04:00")).toBe(
      new Date("2026-03-30T04:00:00+02:00").getTime(),
    );
  });

  it("detects only cron run sessions with parent sessions as parented", () => {
    expect(
      hasParentedCronRunSessionMarker([
        {
          type: "custom",
          customType: CRON_RUN_SESSION_CUSTOM_TYPE,
          data: { version: 1, kind: "run", jobId: "job-1", runId: "run-1" },
        },
      ]),
    ).toBe(false);

    expect(
      hasParentedCronRunSessionMarker([
        {
          type: "custom",
          customType: CRON_RUN_SESSION_CUSTOM_TYPE,
          data: {
            version: 1,
            kind: "run",
            jobId: "job-1",
            runId: "run-1",
            parentSessionId: "parent-session",
          },
        },
      ]),
    ).toBe(true);
  });

  it("finds the latest matching daily cron binding for the local day", () => {
    const older = buildDailyCronSessionBinding(new Date("2026-03-30T08:00:00Z"), "04:00");
    const today = buildDailyCronSessionBinding(new Date("2026-03-31T08:00:00Z"), "04:00");

    const entries = [
      { type: "custom", customType: CRON_SESSION_CUSTOM_TYPE, data: older },
      { type: "custom", customType: "other", data: { nope: true } },
      { type: "custom", customType: CRON_SESSION_CUSTOM_TYPE, data: today },
    ];

    expect(findLatestDailyCronSessionBinding(entries)).toEqual(today);
    expect(findDailyCronSessionBinding(entries, "2026-03-31")).toEqual(today);
  });
});
