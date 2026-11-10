// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { RemoteWorkers } from "./remote-workers";
import { observeSession } from "./session-observer";
import type { Runtime } from "./runtime";
import type { WorkerCommandContext } from "./orchestration-workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
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

test("local mirror events keep one revision clock across divergent remote counters and remote restart", async () => {
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
  let client: SessionState | undefined;
  const events: ServerEvent[] = [];
  const controller = new AbortController();
  const close = observeSession(
    runtime,
    "remote:work:123",
    { state: async (state) => state } as TranscriptImages,
    undefined,
    async (value) => {
      const event = value as ServerEvent;
      events.push(event);
      client = applyServerEvent(client, event);
    },
    controller.signal,
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

test("offline mirrors preserve lifecycle status across reload and inspect uses only saved knowledge", async () => {
  const root = await mkdtemp(join(tmpdir(), "batty-mirror-offline-"));
  const directory = join(root, ".batty", "remote-mirrors");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "work-123.json"),
    JSON.stringify({
      node: "work",
      session: "123",
      summary: { sessionId: "123", workspaceId: "work", status: "running" },
      state: sourceState(1, "last known partial"),
      messages: [],
      error: "Remote disconnected",
    }),
  );
  await writeFile(
    join(directory, "assignments.json"),
    JSON.stringify({
      origins: {},
      assignments: [
        {
          node: "work",
          session: "123",
          parentId: 1,
          requestId: "request",
          prompt: "Build project",
        },
      ],
    }),
  );
  const runtime = {
    config: { battyDir: root },
    main: { id: 1 },
    streamId: "local",
    nextRevision: () => 1,
  } as unknown as Runtime;
  let remotes = await RemoteWorkers.open(runtime);
  try {
    await remotes.access.addConnection({
      id: "work",
      label: "Work",
      url: "https://unreachable.invalid/",
      token: "test",
    });
    await remotes.close();
    remotes = await RemoteWorkers.open(runtime);
    expect(remotes.list()[0]).toMatchObject({ status: "running", connectionState: "offline" });
    expect(remotes.tasks(1)[0]).toMatchObject({
      prompt: "Build project",
      remote: { status: "running", connectionState: "offline" },
    });
    expect(remotes.state("remote:work:123")).toMatchObject({
      canStopSubagent: false,
      remote: { status: "running", connectionState: "offline" },
    });
    const result = await remotes.command(
      { action: "inspect", sessionId: "remote:work:123" },
      {} as WorkerCommandContext,
      BACKGROUND_CONTEXT,
    );
    expect(JSON.parse(result.output[0]!.text)).toMatchObject({
      sessionId: "remote:work:123",
      status: "running",
      connectionState: "offline",
    });
    expect(JSON.parse(result.output[0]!.text)).not.toHaveProperty("latest");
  } finally {
    await remotes.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("remote follow separates session changes from task-list notifications", async () => {
  const root = await mkdtemp(join(tmpdir(), "batty-mirror-notifications-"));
  const directory = join(root, ".batty", "remote-mirrors");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "work-123.json"),
    JSON.stringify({
      node: "work",
      session: "123",
      summary: { sessionId: "123", workspaceId: "work", status: "running" },
      state: sourceState(1, "initial"),
      messages: [],
      syncedTerminal: true,
    }),
  );
  await writeFile(
    join(directory, "assignments.json"),
    JSON.stringify({
      origins: {},
      assignments: [{ node: "work", session: "123", parentId: 1, requestId: "request" }],
    }),
  );
  const runtime = {
    config: { battyDir: root },
    main: { id: 1 },
    streamId: "local",
    nextRevision: () => 1,
  } as unknown as Runtime;
  const remotes = await RemoteWorkers.open(runtime);
  const controllers: ReadableStreamDefaultController<ServerEvent>[] = [];
  const closedControllers = new WeakSet<ReadableStreamDefaultController<ServerEvent>>();
  const closeStream = (controller: ReadableStreamDefaultController<ServerEvent>) => {
    if (closedControllers.has(controller) || controller.desiredSize === null) return;
    closedControllers.add(controller);
    controller.close();
  };
  const changes: unknown[][] = [];
  const taskNotifications: unknown[][] = [];
  const logError = vi.spyOn(console, "error").mockImplementation(() => {});
  const waitFor = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 100 && !condition(); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      condition(),
      `waitFor timed out; changes=${changes.length}, tasks=${taskNotifications.length}, streams=${controllers.length}`,
    ).toBe(true);
  };

  try {
    await remotes.access.addConnection({
      id: "work",
      label: "Work",
      url: "https://remote.example/",
      token: "test",
    });
    Object.defineProperty(remotes, "requestNode", {
      configurable: true,
      value: async (
        _connection: unknown,
        _operation: unknown,
        _input: unknown,
        options: { signal: AbortSignal },
      ) => ({
        value: null,
        events: new ReadableStream<ServerEvent>({
          start: (controller) => {
            controllers.push(controller);
            options.signal.addEventListener("abort", () => closeStream(controller), { once: true });
          },
          cancel: () => {
            const controller = controllers.at(-1);
            if (controller) closedControllers.add(controller);
          },
        }),
      }),
    });
    remotes.changes.on("change", (...args) => changes.push(args));
    remotes.changes.on("tasks", (...args) => taskNotifications.push(args));
    (remotes as unknown as { follow(mirror: unknown): void }).follow({
      node: "work",
      session: "123",
      summary: { sessionId: "123", workspaceId: "work", status: "running" },
      state: sourceState(1, "initial"),
      messages: [],
      syncedTerminal: true,
    });
    await waitFor(() => controllers.length === 1);

    controllers[0]!.enqueue({
      type: "assistant",
      assistant: { ...sourceState(2, "token").activeAssistant! },
    });
    controllers[0]!.enqueue({ type: "tools", tools: [] });
    await waitFor(() => changes.length === 2);
    expect(changes.map(([id]) => id)).toEqual(["remote:work:123", "remote:work:123"]);
    expect(taskNotifications).toHaveLength(0);

    controllers[0]!.enqueue({
      type: "state",
      state: { model: "provider/model-v2", thinkingLevel: "high" } as Extract<
        ServerEvent,
        { type: "state" }
      >["state"],
    });
    await waitFor(() => taskNotifications.length === 1);
    expect(taskNotifications).toHaveLength(1);

    closeStream(controllers[0]!);
    await waitFor(() => taskNotifications.length === 2);
    await waitFor(() => controllers.length === 2);
    controllers[1]!.enqueue({
      type: "assistant",
      assistant: { ...sourceState(3, "recovered").activeAssistant! },
    });
    await waitFor(() => taskNotifications.length === 3);
    expect(changes.map(([id]) => id)).toEqual([
      "remote:work:123",
      "remote:work:123",
      "remote:work:123",
      "remote:work:123",
      "remote:work:123",
    ]);
    remotes.disconnect("work");
    await waitFor(() => taskNotifications.length === 4);
    expect(changes.at(-1)).toEqual([]);
  } finally {
    logError.mockRestore();
    await remotes.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

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
      error: "Peer disconnected after completion",
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
    expect(state.remote).toMatchObject({ connectionState: "online", status: "completed" });
    expect(state.remote?.error).toBeUndefined();
    expect(remotes.list()[0]).toMatchObject({ status: "completed", connectionState: "online" });
    expect(remotes.list()[0]).not.toHaveProperty("error");
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
