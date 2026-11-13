// @vitest-environment node
import { expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createWorkers } from "./orchestration-workers";
import { OrchestrationDoc, WorkerDoc } from "./orchestration-state";
import { RemoteWorkers } from "./remote-workers";
import { createNodeRpcHandler } from "./node-rpc";

function worker(sessionId: string, status = "running", workspaceId = "work") {
  return { sessionId, parentId: "1", workspaceId, status };
}

function listFixture(
  remotes: ReturnType<typeof worker>[],
  localIds: number[] = [],
  historyPages: Array<{ items: Array<{ id: number }>; next?: object }> = [{ items: [] }],
) {
  const state = {
    mainId: 1,
    workers: Object.fromEntries(
      localIds.map((id) => [id, { id, parentId: 1, workspaceId: "work", active: id + 100 }]),
    ),
  };
  const tx = {
    doc: async (doc: unknown) =>
      doc === OrchestrationDoc ? state : { isSubagent: true, parentId: 1 },
    conversation: async () => ({}),
    task: async () => ({ state: { status: "running" } }),
    scanConversations: async (_query: unknown, _limit: number, cursor?: object) =>
      historyPages[cursor ? 1 : 0],
  };
  const workers = createWorkers(
    { remoteWorkers: { list: () => remotes } } as never,
    undefined as never,
  );
  return async (args: object) => {
    const result = await workers.command(
      { action: "list", ...args },
      {
        conversationId: 1,
        snapshot: async (doc: unknown) => (doc === OrchestrationDoc ? state : undefined),
        commit: async (fn: (tx: unknown) => unknown) => fn(tx),
      } as never,
      context,
    );
    return JSON.parse((result.output as Array<{ text: string }>)[0]!.text);
  };
}

test("coordinator pages local and remote workers without exceeding the limit or losing entries", async () => {
  const list = listFixture(
    [worker("remote:mac:2"), worker("remote:windows:8"), worker("remote:mac:12")],
    [2, 3],
  );
  const found = [];
  let cursor: string | undefined;
  do {
    const page = await list({ limit: 1, cursor });
    expect(page.workers.length).toBeLessThanOrEqual(1);
    found.push(...page.workers.map((item: { sessionId: string }) => item.sessionId));
    cursor = page.nextCursor;
  } while (cursor);
  expect(found).toEqual(["3", "2", "remote:windows:8", "remote:mac:12", "remote:mac:2"]);
});

test("history preserves empty local scan pages and hands off to remote pages", async () => {
  const list = listFixture(
    [worker("remote:mac:12"), worker("remote:mac:11")],
    [3],
    [{ items: [{ id: 99 }], next: { after: 99, order: "descending" } }, { items: [{ id: 3 }] }],
  );
  const first = await list({ status: "all", limit: 1 });
  expect(first.workers).toEqual([]);
  const found = [];
  let cursor = first.nextCursor;
  do {
    const page = await list({ status: "all", limit: 1, cursor });
    expect(page.workers.length).toBeLessThanOrEqual(1);
    found.push(...page.workers.map((item: { sessionId: string }) => item.sessionId));
    cursor = page.nextCursor;
  } while (cursor);
  expect(found).toEqual(["3", "remote:mac:12", "remote:mac:11"]);
});

test("remote-only pages filter workspace/status and retain position if the cursor worker disappears", async () => {
  const remotes = [
    worker("remote:mac:4"),
    worker("remote:mac:3", "completed"),
    worker("remote:mac:2"),
    worker("remote:mac:1", "running", "other"),
  ];
  const list = listFixture(remotes);
  const first = await list({ limit: 1, workspaceId: "work" });
  expect(first.workers.map((item: { sessionId: string }) => item.sessionId)).toEqual([
    "remote:mac:4",
  ]);
  remotes.shift();
  const second = await list({ limit: 1, workspaceId: "work", cursor: first.nextCursor });
  expect(second.workers.map((item: { sessionId: string }) => item.sessionId)).toEqual([
    "remote:mac:2",
  ]);
  expect(second.nextCursor).toBeUndefined();
  const history = await list({ limit: 10, status: "all", workspaceId: "work" });
  expect(history.workers.map((item: { sessionId: string }) => item.sessionId)).toEqual([
    "remote:mac:3",
    "remote:mac:2",
  ]);
});

test("all-node discovery exposes each offline error and retains healthy nodes; explicit failure rejects", async () => {
  const receiver = Object.create(RemoteWorkers.prototype);
  receiver.access = { listConnections: () => [{ id: "healthy" }, { id: "sleeping" }] };
  receiver.connection = (id: string) => ({ id, label: id });
  receiver.nodeRequest = async ({ id }: { id: string }) => {
    if (id === "sleeping") throw new Error("sleeping socket is offline");
    return { workspaces: [{ id: "work" }], models: [], defaultModel: "healthy/model" };
  };
  expect(await receiver.workspaces()).toEqual([
    {
      nodeId: "healthy",
      label: "healthy",
      workspaces: [{ id: "work" }],
      models: [],
      defaultModel: "healthy/model",
    },
    { nodeId: "sleeping", label: "sleeping", error: "Error: sleeping socket is offline" },
  ]);
  await expect(receiver.workspaces("sleeping")).rejects.toThrow("sleeping socket is offline");
});

test("remote mirror, node-scoped list and online/offline inspect qualify execution parent IDs", async () => {
  const receiver = Object.create(RemoteWorkers.prototype);
  const summary = worker("12");
  const mirror = { node: "mac", session: "12", summary, messages: [] };
  receiver.mirrors = new Map([["remote:mac:12", mirror]]);
  receiver.access = { getConnection: () => ({ id: "mac" }) };
  receiver.connection = () => ({ id: "mac" });
  receiver.nodeRequest = async (
    _connection: unknown,
    _operation: unknown,
    input: { command: { action: string } },
  ) => ({
    output: [
      {
        type: "text",
        text: JSON.stringify(input.command.action === "list" ? { workers: [summary] } : summary),
      },
    ],
  });
  const api = { conversationId: 1, taskId: 2 };
  expect(receiver.list()[0]).toMatchObject({
    sessionId: "remote:mac:12",
    parentId: "remote:mac:1",
  });
  for (const action of ["list", "inspect"]) {
    const result = await receiver.command(
      { action, nodeId: "mac", ...(action === "inspect" ? { sessionId: "remote:mac:12" } : {}) },
      api,
      context,
    );
    const decoded = JSON.parse(result.output[0].text);
    expect(action === "list" ? decoded.workers[0] : decoded).toMatchObject({
      sessionId: "remote:mac:12",
      parentId: "remote:mac:1",
    });
  }
  receiver.mirrors.get("remote:mac:12").error = "offline";
  const offline = await receiver.command(
    { action: "inspect", sessionId: "remote:mac:12" },
    api,
    context,
  );
  expect(JSON.parse(offline.output[0].text).parentId).toBe("remote:mac:1");
});

test("inspect exposes a faulted assignment's concrete error without hiding its prior report", async () => {
  const state = {
    mainId: 1,
    workers: { "12": { id: 12, parentId: 1, active: 34, workspaceId: "work" } },
  };
  const metadata = {
    isSubagent: true,
    parentId: 1,
    latestReport: { assignmentId: 30, text: "earlier progress", artifacts: {} },
  };
  const tx = {
    doc: async (doc: unknown) =>
      doc === OrchestrationDoc ? state : doc === WorkerDoc ? metadata : {},
    conversation: async () => ({}),
    task: async () => ({
      state: {
        status: "terminal",
        outcome: { status: "faulted", error: { message: "prepareAgent exploded" } },
      },
    }),
    scanEntries: async () => ({ items: [] }),
  };
  const workers = createWorkers({} as never, undefined as never);
  const result = await workers.command(
    { action: "inspect", sessionId: "12" },
    {
      conversationId: 1,
      snapshot: async () => state,
      commit: async (fn: (tx: unknown) => unknown) => fn(tx),
    } as never,
    context,
  );
  expect(JSON.parse((result.output as Array<{ text: string }>)[0]!.text)).toMatchObject({
    status: "faulted",
    error: "prepareAgent exploded",
    latest: { kind: "report", text: "earlier progress" },
  });
});

test("remote assignment joins receive the concrete faulted error", async () => {
  const connection = { id: "mac", instanceId: "peer", localGrantId: "grant" };
  const handler = createNodeRpcHandler(
    {
      access: { pairedConnection: () => connection, listGrants: () => [{ id: "grant" }] },
      runtime: {
        harness: {
          getTask: async () => ({
            kind: "batty.delivery",
            state: {
              status: "terminal",
              outcome: { status: "faulted", error: { message: "remote preparation exploded" } },
            },
          }),
          snapshot: async () => ({}),
        },
      },
    } as never,
    connection as never,
  );
  const result = await handler("node.assignment", { assignmentId: "34" }, {
    signal: new AbortController().signal,
  } as never);
  expect(result.value).toMatchObject({ status: "faulted", text: "remote preparation exploded" });
});
