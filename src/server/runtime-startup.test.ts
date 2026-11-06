import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { loadConfig } from "./config";
import { Runtime, context } from "./runtime";
import { OrchestrationDoc } from "./orchestration";
import { RemoteWorkers } from "./remote-workers";

test("startup restores direct memory tools from a persisted pre-search allowlist", async () => {
  const directory = await mkdtemp(join(tmpdir(), "batty2-memory-tools-"));
  vi.stubEnv("PI_OFFLINE", "1");
  await mkdir(join(directory, ".batty"));
  await mkdir(join(directory, "work"));
  await writeFile(
    join(directory, ".batty", "options.json"),
    JSON.stringify({ workspacesRoots: [directory], webPushSubject: "mailto:test@example.com" }),
  );
  const config = {
    ...(await loadConfig(directory)),
    selfPath: join(directory, "work"),
    workspacesRoots: [directory],
    defaultProvider: "faux",
    defaultModel: "memory-tools-test",
  };
  const faux = fauxProvider({ models: [{ id: "memory-tools-test" }] });
  let runtime: Runtime | undefined;
  try {
    runtime = await Runtime.open(config, { resume: false });
    const legacy = (await runtime.main.agent(context)).tools.filter(
      (tool) => tool.name !== "memory_search",
    );
    await runtime.main.configure({ tools: legacy }, context);
    expect((await runtime.main.agent(context)).tools.map((tool) => tool.name)).not.toContain(
      "memory_search",
    );
    await runtime.close();
    runtime = undefined;
    runtime = await Runtime.open(config, { resume: false });
    const names = (await runtime.main.agent(context)).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["memory_zoom", "memory_search", "codemode"]));
    expect(names.filter((name) => name.startsWith("memory_"))).toEqual([
      "memory_zoom",
      "memory_search",
    ]);
    expect(names).not.toContain("memory_overview");
    expect(names).not.toContain("memory_date");
    expect(names).not.toContain("zoom");
    expect(names).not.toContain("date");
    runtime.models.registerNativeProvider(faux.provider);
    faux.setResponses([
      (request) => {
        const tools = getCurrentTools(request.messages);
        expect(tools.map((tool) => tool.name)).toEqual(
          expect.arrayContaining(["memory_zoom", "memory_search"]),
        );
        expect(tools.find((tool) => tool.name === "memory_search")?.parameters).toMatchObject({
          required: ["query"],
          properties: { query: { type: "string", maxLength: 256 } },
        });
        return fauxAssistantMessage([fauxToolCall("memory_search", { query: "unfindableword" })], {
          stopReason: "toolUse",
        });
      },
      fauxAssistantMessage(
        [
          fauxToolCall("codemode", {
            code: "text(await tools.memory_search({query: 'unfindableword'}));",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    expect(
      (
        await (
          await runtime.main.submit({ type: "input", content: "check memory tools" }, context)
        ).wait(context)
      ).status,
    ).toBe("done");
    const view = await runtime.main.watch(context);
    try {
      const results = view.value.entries
        .flatMap((entry) => entry.model ?? [])
        .filter((message) => message.role === "toolResult");
      expect(results.map((message) => message.toolName)).toEqual(["memory_search", "codemode"]);
      expect(results.every((message) => !message.isError)).toBe(true);
    } finally {
      view.stop();
    }
  } finally {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 15000);

test("startup installs observers and remote joins before due cron resumes persisted work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "batty2-startup-"));
  vi.stubEnv("PI_OFFLINE", "1");
  await mkdir(join(directory, ".batty"));
  await mkdir(join(directory, "work"));
  await writeFile(
    join(directory, ".batty", "options.json"),
    JSON.stringify({
      workspacesRoots: [directory],
      webPushSubject: "mailto:test@example.com",
    }),
  );
  const config = {
    ...(await loadConfig(directory)),
    selfPath: join(directory, "work"),
    workspacesRoots: [directory],
    defaultProvider: "faux",
    defaultModel: "startup-test",
  };
  const faux = fauxProvider({ models: [{ id: "startup-test" }] });
  faux.setResponses([fauxAssistantMessage([fauxText("startup cron reply")])]);
  let runtime: Runtime | undefined;
  let stop: (() => void) | undefined;
  const observed: string[] = [];
  // Stub the remote wait; the persisted join task and scheduler execute their
  // real definitions across the restart, including service lookup and settlement.
  const joinRemote = vi.spyOn(RemoteWorkers.prototype, "join").mockResolvedValue();
  try {
    runtime = await Runtime.open(config, { resume: false });
    const joinId = await runtime.main.commit(
      (tx) =>
        tx.createTask(
          runtime!.orchestration.remoteJoinTask,
          {
            node: "remote-test",
            session: "1",
            assignmentId: "startup-assignment",
            parentId: runtime!.main.id,
          },
          { ownership: { kind: "conversation" }, background: true },
        ),
      context,
    );
    const job = await runtime.orchestration.addJob({
      title: "Scheduled test task",
      prompt: "startup cron task",
      schedule: { kind: "at", in: "1h" },
    });
    await runtime.main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
    }, context);
    await runtime.close();
    runtime = undefined;
    runtime = await Runtime.open(config, {
      resume: false,
      beforeStart: (opened) => {
        opened.models.registerNativeProvider(faux.provider);
        stop = opened.harness.observeCommits({
          advance: (publication) => {
            for (const change of publication.changes) {
              if (change.type !== "entry") continue;
              for (const message of change.value.model ?? []) {
                if (message.role !== "assistant") continue;
                observed.push(
                  ...message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
                );
              }
            }
          },
          end: () => {},
        }).detach;
      },
    });
    for (let i = 0; i < 1000; i++) {
      if ((await runtime.orchestration.listRunLogs())[0]?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await runtime.orchestration.listRunLogs())[0]?.status).toBe("completed");
    expect(observed).toContain("startup cron reply");
    const join = await runtime.harness.getTask(joinId, context);
    expect(join?.state).toMatchObject({
      status: "terminal",
      outcome: { status: "completed" },
    });
    expect(joinRemote).toHaveBeenCalledOnce();
  } finally {
    stop?.();
    await runtime?.close();
    joinRemote.mockRestore();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 15000);
