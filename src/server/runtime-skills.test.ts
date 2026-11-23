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
import { loadConfig } from "./config";
import { writeStoredOptions } from "./options";
import { OrchestrationDoc } from "./orchestration";
import { Runtime, context } from "./runtime";
import { until } from "./orchestration-test-fixture";

vi.mock(import("./network-recovery"), async (original) => ({
  ...(await original()),
  networkAvailable: async () => true,
}));

test("main, subagent and cron model requests include only their workspace and global skills", async () => {
  const directory = await mkdtemp(join(tmpdir(), "batty-runtime-skills-"));
  const projects = join(directory, "projects");
  const assistant = join(projects, "assistant");
  const worker = join(projects, "worker");
  const scheduled = join(projects, "scheduled");
  const self = join(directory, "self");
  const sources = {
    assistant: [assistant, "skills"],
    worker: [worker, "skills"],
    cron: [scheduled, "skills"],
    legacy: [worker, ".batty", "skills"],
    global: [directory, ".batty", "skills"],
    self: [self, "skills"],
  };
  let runtime: Runtime | undefined;
  vi.stubEnv("PI_OFFLINE", "1");
  try {
    const skills = await Promise.all(
      Object.entries(sources).map(async ([scope, parts]) => {
        const folder = join(...parts, `fixture-${scope}`);
        const file = join(folder, "SKILL.md");
        await mkdir(folder, { recursive: true });
        await writeFile(
          file,
          `---\nname: fixture-${scope}\ndescription: Skill for ${scope}\n---\n`,
        );
        return [scope, file] as const;
      }),
    );
    await writeStoredOptions(directory, {
      workspacesRoots: [projects],
      assistantWorkspaceId: "assistant",
      webPushSubject: "mailto:test@example.com",
    });
    const faux = fauxProvider({ models: [{ id: "skills-test" }] });
    const prompts = new Map<string, string>();
    const capture = (request: { messages: readonly { role: string; content: unknown }[] }) =>
      JSON.stringify(request.messages.filter((message) => message.role === "system"));
    faux.setResponses(
      Array.from({ length: 12 }, () => (request) => {
        const last = request.messages.findLast((message) => message.role !== "system");
        const input = last?.role === "user" ? JSON.stringify(last.content) : "";
        if (input.includes("start fixture worker")) {
          prompts.set("assistant", capture(request));
          return fauxAssistantMessage(
            [
              fauxToolCall("subagent", {
                action: "run",
                workspaceId: "worker",
                prompt: "fixture worker assignment",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }
        if (input.includes("fixture worker assignment")) prompts.set("worker", capture(request));
        if (input.includes("fixture cron assignment")) prompts.set("cron", capture(request));
        return fauxAssistantMessage([fauxText("done")]);
      }),
    );
    runtime = await Runtime.open(
      {
        ...(await loadConfig(directory)),
        selfPath: self,
        defaultProvider: "faux",
        defaultModel: "skills-test",
        memoryModel: "faux/skills-test",
      },
      { beforeStart: (opened) => opened.models.registerNativeProvider(faux.provider) },
    );
    const { main, orchestration } = runtime;
    await (
      await main.submit({ type: "input", content: "start fixture worker" }, context)
    ).wait(context);
    await until(
      async () => prompts.has("worker") && (await orchestration.listRunning()).length === 0,
    );

    const job = await orchestration.addJob({
      title: "Skill scope fixture",
      workspaceId: "scheduled",
      prompt: "fixture cron assignment",
      schedule: { kind: "at", in: "1h" },
      delivery: "direct",
    });
    await main.commit(async (tx) => {
      (await tx.doc(OrchestrationDoc)).jobs[job.id]!.nextAt = Date.now() - 1;
    }, context);
    await orchestration.tick();
    await until(async () => (await orchestration.listRunLogs(job.id))[0]?.status === "completed");

    for (const [scope, expected] of Object.entries({
      assistant: ["assistant", "global"],
      worker: ["global", "legacy", "worker"],
      cron: ["cron", "global"],
    })) {
      expect(prompts.has(scope)).toBe(true);
      const discovered = skills.filter(([, file]) => prompts.get(scope)!.includes(file));
      expect(discovered.map(([name]) => name).sort(), scope).toEqual(expected);
    }
  } finally {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 15000);
