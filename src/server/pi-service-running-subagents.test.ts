import { describe, expect, it } from "vite-plus/test";
import { PiService } from "./pi-service";
import type { RunningSubagent } from "@/shared/types";

function createService(subagents: RunningSubagent[], streamingSessionIds: string[]): PiService {
  const service = Object.create(PiService.prototype) as PiService;
  const internals = service as unknown as {
    runningSubagents: Map<string, RunningSubagent>;
    liveSessions: Map<string, { session: { isStreaming: boolean } }>;
  };
  internals.runningSubagents = new Map(subagents.map((subagent) => [subagent.sessionId, subagent]));
  internals.liveSessions = new Map(
    subagents.map((subagent) => [
      subagent.sessionId,
      { session: { isStreaming: streamingSessionIds.includes(subagent.sessionId) } },
    ]),
  );
  return service;
}

function subagent(
  sessionId: string,
  parentSessionId: string,
  startedAtMs: number,
): RunningSubagent {
  return {
    sessionId,
    sessionPath: `/tmp/${sessionId}.jsonl`,
    workspaceId: "batty",
    parentSessionId,
    prompt: `Run ${sessionId}`,
    model: "openai/gpt-5",
    thinkingLevel: "medium",
    startedAtMs,
  };
}

describe("PiService.listRunningSubagents", () => {
  it("returns only streaming children of the requested session", () => {
    const running = subagent("child-running", "parent-1", 2);
    const completed = subagent("child-completed", "parent-1", 1);
    const unrelated = subagent("child-other", "parent-2", 3);
    const service = createService(
      [running, completed, unrelated],
      [running.sessionId, unrelated.sessionId],
    );

    expect(service.listRunningSubagents("parent-1")).toEqual([running]);
  });
});
