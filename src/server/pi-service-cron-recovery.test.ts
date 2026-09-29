import { afterEach, describe, expect, it } from "vite-plus/test";
import { createAgentSessionFixture } from "./agent-session-test-fixture";
import {
  executeCronOperation,
  getCronExecutionResult,
  CRON_EXECUTION_CUSTOM_TYPE,
} from "./pi-service-cron-adapter";
import { buildCronRuntimeNotice } from "./runtime-notices";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

const fixtures: Awaited<ReturnType<typeof createAgentSessionFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});
const notice = () =>
  buildCronRuntimeNotice({ scheduleLabel: "Hourly", prompt: "Do work", session: { kind: "new" } });

async function setup() {
  const fixture = await createAgentSessionFixture();
  fixtures.push(fixture);
  return fixture;
}

describe("cron AgentSession execution", () => {
  it("persists scheduler execution boundaries and does not replay completed runs", async () => {
    const fixture = await setup();
    fixture.faux.setResponses([fauxAssistantMessage("done")]);
    await executeCronOperation(fixture.session, notice(), "cron-run");
    expect(getCronExecutionResult(fixture.session, "cron-run")).toMatchObject({
      runId: "cron-run",
      status: "completed",
      endEntryId: expect.any(String),
    });
    await executeCronOperation(await fixture.reopen(), notice(), "cron-run");
    expect(fixture.faux.state.callCount).toBe(1);
  });

  it("does not resume an interrupted native SDK turn", async () => {
    const fixture = await setup();
    await fixture.session.sessionManager.appendCustomEntry(CRON_EXECUTION_CUSTOM_TYPE, {
      runId: "interrupted",
      startEntryId: null,
      endEntryId: null,
      status: "running",
    });
    await expect(
      executeCronOperation(await fixture.reopen(), notice(), "interrupted"),
    ).rejects.toThrow("Cron run running");
    expect(fixture.faux.state.callCount).toBe(0);
  });
});
