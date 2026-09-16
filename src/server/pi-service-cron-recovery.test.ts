import { afterEach, describe, expect, it } from "vite-plus/test";
import { createHarnessFixture } from "./harness-test-fixture";
import { executeCronOperation } from "./pi-service-cron-adapter";
import { buildCronRuntimeNotice } from "./runtime-notices";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

const fixtures: Awaited<ReturnType<typeof createHarnessFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

describe("cron operation execution", () => {
  it("drives an explicitly admitted cron operation without recovery", async () => {
    const fixture = await createHarnessFixture();
    fixtures.push(fixture);
    fixture.faux.setResponses([fauxAssistantMessage("done")]);

    await executeCronOperation(
      fixture.session,
      buildCronRuntimeNotice({
        scheduleLabel: "Hourly",
        prompt: "Do work",
        session: { kind: "new" },
      }),
      "cron-run",
    );

    expect(fixture.session.snapshot.lastResult).toMatchObject({
      operationId: "cron-run",
      status: "completed",
    });
  });
});
