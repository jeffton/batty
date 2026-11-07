import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "./config";
import { writeStoredOptions } from "./options";
import { Runtime, context } from "./runtime";
import { buildCronRuntimeNotice, buildSubagentRuntimeNotice } from "./runtime-notices";

const instruction = "You can run brief tool calls here, but delegate all tasks to subagents.";

test("clean installations delegate from main, not from workers or scheduled scopes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "batty-main-delegation-"));
  vi.stubEnv("PI_OFFLINE", "1");
  const workspace = join(directory, "work");
  const project = join(directory, "project");
  await mkdir(workspace);
  await mkdir(project);
  await writeStoredOptions(directory, {
    workspacesRoots: [directory],
    webPushSubject: "mailto:test@example.com",
  });
  const config = {
    ...(await loadConfig(directory)),
    selfPath: workspace,
    workspacesRoots: [directory],
    defaultProvider: "faux",
    defaultModel: "delegation-test",
  };
  const faux = fauxProvider({ models: [{ id: "delegation-test" }] });
  let runtime: Runtime | undefined;
  try {
    runtime = await Runtime.open(config, { resume: false });
    runtime.models.registerNativeProvider(faux.provider);
    const scopes = [
      { conversation: runtime.main, prompt: "main request", delegates: true },
      ...(await Promise.all(
        [
          { cwd: workspace, notice: buildSubagentRuntimeNotice(1, "assistant workspace task") },
          { cwd: project, notice: buildSubagentRuntimeNotice(2, "project worker task") },
          {
            cwd: workspace,
            notice: buildCronRuntimeNotice({ scheduleLabel: "test", prompt: "scheduled task" }),
          },
        ].map(async ({ cwd, notice }) => ({
          conversation: await runtime!.harness.createConversation(
            {
              ownership: { kind: "ownerless" },
              agent: { cwd, model: { provider: "faux", modelId: "delegation-test" } },
            },
            context,
          ),
          prompt: notice.text,
          delegates: false,
        })),
      )),
    ];
    for (const { conversation, prompt, delegates } of scopes) {
      let checked = false;
      faux.setResponses([
        (request) => {
          const system = request.messages
            .filter((message) => message.role === "system")
            .map((message) => JSON.stringify(message))
            .join("\n");
          expect(system).toContain(
            "You are running in Batty, a runtime with one permanent main thread.",
          );
          expect(system.includes(instruction)).toBe(delegates);
          checked = true;
          return fauxAssistantMessage([fauxText("done")]);
        },
      ]);
      expect(
        (
          await (
            await conversation.submit({ type: "input", content: prompt }, context)
          ).wait(context)
        ).status,
      ).toBe("done");
      expect(checked).toBe(true);
    }
  } finally {
    await runtime?.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
