// @vitest-environment node
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { RemoteWorkers } from "./remote-workers";
import { streamSession } from "./session-sse";
import type { Runtime } from "./runtime";
import type { TranscriptImages } from "./transcript-images";
import type { ServerEvent, SessionState } from "../shared/types";
import { applyServerEvent } from "../client/lib/session-events";

function sourceState(revision: number, text: string): SessionState {
  return {
    id: "123",
    sessionId: "123",
    streamId: `remote-${revision}`,
    revision,
    workspaceId: "work",
    cwd: "/remote/work",
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    isStreaming: true,
    pendingMessageCount: 0,
    updatedAt: 1,
    contextTokens: null,
    contextWindow: null,
    contextPercent: null,
    totalMessageCount: 0,
    hasMoreMessages: false,
    messages: [],
    activeTools: [],
    canStopSubagent: true,
    activeAssistant: {
      id: "partial",
      role: "assistant",
      timestamp: 1,
      turnPhase: "pending",
      blocks: [{ type: "text", text }],
    },
  };
}

test("local mirror SSE keeps one revision clock across divergent remote counters and remote restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "batty-mirror-clock-"));
  const directory = join(root, ".batty", "remote-mirrors");
  await mkdir(directory, { recursive: true });
  let revision = 10;
  const runtime = {
    config: { battyDir: root },
    main: { id: 1 },
    streamId: "local",
    nextRevision: () => ++revision,
  } as unknown as Runtime;
  const file = join(directory, "work-123.json");
  const mirror = {
    node: "work",
    session: "123",
    summary: { sessionId: "123", workspaceId: "work", status: "running" },
    after: "100",
    messages: [],
    state: sourceState(9000, "first"),
  };
  await writeFile(file, JSON.stringify(mirror));
  let current = await RemoteWorkers.open(runtime);
  let changed!: (history: boolean) => void;
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    writableNeedDrain: false,
  });
  let client: SessionState | undefined;
  const events: ServerEvent[] = [];
  const stream = Object.assign(socket, {
    write: (payload: string) => {
      if (payload.startsWith("data:")) {
        const event = JSON.parse(payload.slice(5)) as ServerEvent;
        events.push(event);
        client = applyServerEvent(client, event);
      }
      return true;
    },
  });
  const close = streamSession(
    stream as unknown as ServerResponse,
    runtime,
    "remote:work:123",
    { state: async (state) => state } as TranscriptImages,
    undefined,
    (error) => {
      throw error;
    },
    {
      state: async (history, after) => current.state("remote:work:123", history, after),
      subscribe: (update) => {
        changed = update;
        return () => {};
      },
    },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client?.streamId).toBe("local");
    expect(client?.revision).toBeLessThan(9000);
    expect(client?.activeAssistant?.blocks).toEqual([{ type: "text", text: "first" }]);
    mirror.state = sourceState(9001, "streamed token");
    await writeFile(file, JSON.stringify(mirror));
    await current.close();
    current = await RemoteWorkers.open(runtime);
    changed(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client?.activeAssistant?.blocks).toEqual([{ type: "text", text: "streamed token" }]);
    const beforeRestart = client!.revision!;
    mirror.state = sourceState(1, "after remote restart");
    await writeFile(file, JSON.stringify(mirror));
    await current.close();
    current = await RemoteWorkers.open(runtime);
    changed(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client?.revision).toBeGreaterThan(beforeRestart);
    expect(client?.activeAssistant?.blocks).toEqual([
      { type: "text", text: "after remote restart" },
    ]);
    expect(
      events.filter((event) => "streamId" in event).every((event) => event.streamId === "local"),
    ).toBe(true);
  } finally {
    close();
    await current.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a synchronized terminal cursor overrides stale remote live fields in sessions and Tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "batty-mirror-terminal-"));
  const directory = join(root, ".batty", "remote-mirrors");
  await mkdir(directory, { recursive: true });
  const file = join(directory, "work-123.json");
  await writeFile(
    file,
    JSON.stringify({
      node: "work",
      session: "123",
      summary: {
        sessionId: "123",
        workspaceId: "work",
        status: "completed",
        terminalCursor: "100",
      },
      after: "100",
      messages: [
        { id: "100", role: "custom", customType: "result", timestamp: 1, text: "completed" },
      ],
      state: sourceState(9000, "stale partial"),
      syncedTerminal: true,
    }),
  );
  const runtime = {
    config: { battyDir: root },
    main: { id: 1 },
    streamId: "local",
    nextRevision: () => 1,
  } as unknown as Runtime;
  const remotes = await RemoteWorkers.open(runtime);
  try {
    await remotes.access.addConnection({
      id: "work",
      label: "Work",
      url: "https://remote.example/",
      token: "test",
    });
    const state = remotes.state("remote:work:123");
    expect(state).toMatchObject({ isStreaming: false, canStopSubagent: false, activeTools: [] });
    expect(state.activeAssistant).toBeUndefined();
    expect(remotes.tasks(1)).toEqual([]);
    // A metadata-only refresh can race a newer archive cursor from another stream.
    expect(remotes.state("remote:work:123", false, "0")).toMatchObject({
      messages: [],
      hasMoreRecentMessages: false,
    });
    // Rendering normalization does not mutate the source snapshot or archive.
    expect(JSON.parse(await readFile(file, "utf8")).state.isStreaming).toBe(true);
  } finally {
    await remotes.close();
    await rm(root, { recursive: true, force: true });
  }
});
