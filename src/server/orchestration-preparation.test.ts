import { expect, test } from "vite-plus/test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { fixture, until } from "./orchestration-test-fixture.js";

test("steering during preparation cannot run before its assignment", async () => {
  const { faux, orchestration, open } = await fixture();
  let release!: () => void;
  let preparing = false;
  const gate = new Promise<{}>((resolve) => {
    release = () => resolve({});
  });
  orchestration.setPrepareAgent(async () => {
    preparing = true;
    return gate;
  });
  const seen: string[] = [];
  faux.setResponses(
    Array.from({ length: 20 }, () => (request) => {
      seen.push(JSON.stringify(request.messages));
      return fauxAssistantMessage([fauxText("done")]);
    }),
  );
  await open();
  try {
    const started = await orchestration.nodeCommand("peer", "start", {
      action: "run",
      prompt: "original assignment",
    });
    const id = /Session ID: (\d+)/.exec(JSON.stringify(started.output))![1]!;
    await until(async () => preparing);
    const steered = await orchestration.nodeCommand("peer", "steer", {
      action: "steer",
      sessionId: id,
      prompt: "premature steering",
    });
    expect(steered.isError).toBe(true);
    expect(JSON.stringify(steered.output)).toContain("preparing");
    expect(seen).toEqual([]);
    release();
    await until(async () => (await orchestration.listRunning()).length === 0);
    expect(seen.some((text) => text.includes("original assignment"))).toBe(true);
    expect(seen.some((text) => text.includes("premature steering"))).toBe(false);
  } finally {
    release();
  }
});
