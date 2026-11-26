import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, vi } from "vite-plus/test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { Runtime, context } from "./runtime";
import { resolveSentFile } from "./send-files";
import { preparePromptFiles } from "./uploads";
import { ArtifactResolver } from "./artifact-resolver";
import {
  test,
  storageRoot,
  nodeRequest,
  eventually,
  openInstance,
  connect,
  connectReverse,
  transcript,
  filesIn,
  importedRef,
  withSelectedFiles,
} from "./remote-workers.integration-fixtures";

export function registerRemoteWorkerExecutionTests() {
  test("bidirectional peers discover independently started workers without claiming them in Tasks", async () => {
    const directory = await mkdtemp(join(storageRoot, "batty-peer-task-ownership-"));
    const instances: Awaited<ReturnType<typeof openInstance>>[] = [];
    try {
      const a = await openInstance(directory, "a");
      instances.push(a);
      const b = await openInstance(directory, "b");
      instances.push(b);
      await connect(a, b);

      for (const instance of instances) {
        instance.faux.setResponses([
          fauxAssistantMessage(
            [
              fauxToolCall("bash", {
                command:
                  "printf ready > entered; for i in $(seq 1 400); do test -f release && exit 0; sleep 0.05; done; exit 1",
              }),
            ],
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage([fauxText("Independent work finished")]),
        ]);
        // Start on this runtime, without a delegation/assignment from its connected peer.
        const started = await instance.runtime.orchestration.nodeCommand("independent", "start", {
          action: "run",
          workspaceId: "work",
          prompt: "independent worker",
        });
        expect(started.isError).not.toBe(true);
      }
      await eventually(
        async () =>
          a.runtime.remotes.list().some((worker) => worker.status === "running") &&
          b.runtime.remotes.list().some((worker) => worker.status === "running"),
        "both peer catalogs",
      );
      expect(a.runtime.remotes.tasks(a.runtime.main.id)).toEqual([]);
      expect(b.runtime.remotes.tasks(b.runtime.main.id)).toEqual([]);
    } finally {
      for (const instance of instances) await writeFile(join(instance.work, "release"), "release");
      for (const instance of instances) {
        await eventually(
          async () => (await instance.runtime.orchestration.listRunning()).length === 0,
          "independent worker shutdown",
        );
        await instance.runtime.main.waitForIdle(context);
        await instance.close();
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 45_000);

  test.each(["forward", "reverse"] as const)(
    "%s socket peers execute remote native tools, deliver progress to the initiating parent, and retain local history/files offline",
    async (transport) => {
      const directory = await mkdtemp(join(storageRoot, "batty-two-runtimes-"));
      let a: Awaited<ReturnType<typeof openInstance>> | undefined;
      let b: Awaited<ReturnType<typeof openInstance>> | undefined;
      try {
        a = await openInstance(directory, "a");
        b = await openInstance(directory, "b");
        const local = a;
        const remote = b;
        if (transport === "reverse") await connectReverse(local, remote);
        else {
          await connect(local, remote);
        }
        await writeFile(join(remote.work, "private-draft.txt"), "unselected draft bytes");
        const upload = await preparePromptFiles(
          remote.config.uploadsDir,
          String(remote.runtime.main.id),
          [{ filename: "selected-input.txt", data: Buffer.from("owner uploaded bytes") }],
          remote.config.baseUrl,
        );
        const selectedUploadRef = /artifactRef="([^"]+)"/.exec(upload.text)![1]!;
        let bModelCalls = 0;
        remote.faux.setResponses([
          (request) => {
            bModelCalls++;
            expect(JSON.stringify(request.messages)).toContain(
              "Unique instance b workspace guidance.",
            );
            expect(JSON.stringify(request.messages)).not.toContain(
              "Unique instance a workspace guidance.",
            );
            expect(getCurrentTools(request.messages).map((tool) => tool.name)).toEqual(
              expect.arrayContaining(["read", "bash", "import_files", "subagent"]),
            );
            return fauxAssistantMessage([fauxToolCall("read", { path: "origin.txt" })], {
              stopReason: "toolUse",
            });
          },
          (request) => {
            bModelCalls++;
            expect(JSON.stringify(request.messages)).toContain("tools executed on b");
            expect(JSON.stringify(request.messages)).not.toContain("tools executed on a");
            return fauxAssistantMessage(
              [
                {
                  ...fauxToolCall("import_files", { paths: ["origin.txt", "private-draft.txt"] }),
                  id: "call/attachment",
                },
              ],
              {
                stopReason: "toolUse",
              },
            );
          },
          (request) =>
            fauxAssistantMessage(
              [
                fauxToolCall("subagent", {
                  action: "report",
                  prompt: "B progress with evidence",
                  artifactRefs: [importedRef(request, "origin.txt"), selectedUploadRef],
                }),
              ],
              { stopReason: "toolUse" },
            ),
          fauxAssistantMessage(
            [
              fauxToolCall("bash", {
                command:
                  "printf ready > entered; for i in $(seq 1 400); do test -f release && exit 0; sleep 0.05; done; exit 1",
              }),
            ],
            { stopReason: "toolUse" },
          ),
          (request) =>
            fauxAssistantMessage([
              withSelectedFiles("B final complete", importedRef(request, "origin.txt")),
            ]),
        ]);
        let localStarted = false;
        local.faux.setResponses(
          Array.from({ length: 20 }, () => (request) => {
            if (!localStarted) {
              localStarted = true;
              return fauxAssistantMessage(
                [
                  fauxToolCall("subagent", {
                    action: "run",
                    nodeId: remote.id,
                    workspaceId: "work",
                    prompt: "Read origin.txt, attach evidence, report progress and finish",
                  }),
                ],
                { stopReason: "toolUse" },
              );
            }
            const last = request.messages.findLast((message) => message.role !== "system");
            if (last?.role === "toolResult" && last.toolName === "subagent") {
              const remoteId = /Started[^]*?Session ID: (remote:[\w-]+:\d+)/.exec(
                JSON.stringify(last),
              )?.[1];
              if (remoteId)
                return fauxAssistantMessage(
                  [fauxToolCall("subagent", { action: "await", sessionId: remoteId })],
                  { stopReason: "toolUse" },
                );
            }
            return fauxAssistantMessage([fauxText("A observed remote activity")]);
          }),
        );
        await (
          await local.runtime.main.submit(
            { type: "input", content: "Start remote integration" },
            context,
          )
        ).wait(context);
        await eventually(async () => {
          try {
            return (await readFile(join(remote.work, "entered"), "utf8")) === "ready";
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
          }
        }, "B's native bash tool");
        expect(bModelCalls).toBe(2);
        expect(await transcript(local.runtime)).toContain("Awaiting subagent");
        const remoteId = local.runtime.remotes.list()[0]!.sessionId.split(":")[2]!;
        const workerContext = (await (await remote.runtime.conversation(remoteId)).context(context))
          .messages;
        const reportReply = workerContext.find(
          (message) => message.role === "toolResult" && message.toolName === "subagent",
        );
        expect(reportReply, JSON.stringify(reportReply)).toMatchObject({ isError: false });
        await eventually(
          async () => (await transcript(local.runtime)).includes("B progress with evidence"),
          "streamed progress on A",
        );
        expect((await remote.runtime.main.context(context)).messages).toHaveLength(0);
        const running = local.runtime.remotes.list();
        expect(running).toHaveLength(1);
        const id = running[0]!.sessionId;
        expect(id.split(":")).toEqual(["remote", remote.id, expect.stringMatching(/^\d+$/)]);
        await eventually(
          async () =>
            local.runtime.remotes.tasks(local.runtime.main.id).some((row) => row.sessionId === id),
          "remote Tasks row",
        );
        // A connection in the reverse direction must not change task ownership.
        expect(remote.runtime.remotes.tasks(remote.runtime.main.id)).toEqual([]);
        expect(local.runtime.remotes.tasks(local.runtime.main.id + 1)).toEqual([]);
        const state = await local.runtime.state(id);
        expect(state.cwd).toBe(remote.work);
        expect(state.model).toBe("faux/model-b");
        expect(state.isStreaming).toBe(true);
        const worker = await remote.runtime.conversation(id.split(":")[2]!);
        expect((await worker.agent(context)).cwd).toBe(remote.work);
        expect((await worker.agent(context)).model).toMatchObject({ modelId: "model-b" });

        const progress = await nodeRequest<{
          presentation: { sentFiles: Array<{ name: string }> };
        }>(
          local.runtime.remotes.connection(remote.id),
          "node.command",
          {
            requestId: "inspect-selected-progress",
            command: { action: "inspect", sessionId: id.split(":")[2] },
          },
          local.runtime.remotes.requestNode,
        );
        expect(progress.presentation.sentFiles.map((file) => file.name)).toEqual([
          "origin.txt",
          "selected-input.txt",
        ]);
        expect(progress).not.toHaveProperty("details");
        expect(JSON.stringify(progress)).not.toContain(remote.config.sentFilesDir);
        expect(
          (await new ArtifactResolver(remote.config).resolve([selectedUploadRef])).sentFiles,
        ).toMatchObject([{ name: "selected-input.txt" }]);

        // A status request can fail after the last terminal catalog commit; reconnect must resync it.
        remote.failNextAssignmentRequest();
        // Interrupt the real socket; the worker must continue independently.
        const listener = transport === "reverse" ? local : remote;
        listener.setNodeOnline(false);
        listener.setNodeOnline(true);
        await writeFile(join(remote.work, "release"), "release");
        await eventually(
          async () => (await remote.runtime.orchestration.listRunning()).length === 0,
          "B finishing during stream disconnect",
        );
        await eventually(
          async () => remote.failedAssignmentRequests() === 1,
          "injected assignment-status failure consumed independently of session replay",
        );
        await eventually(
          async () => (await transcript(local.runtime)).includes("B final complete"),
          "final result on A",
        );
        await eventually(
          async () => local.runtime.remotes.list()[0]?.status === "completed",
          "completed catalog state",
        );
        expect((await remote.runtime.main.context(context)).messages).toHaveLength(0);
        const delivered = await transcript(local.runtime);
        expect(delivered.match(/B progress with evidence/g)).toHaveLength(1);
        expect(delivered.match(/B final complete/g)).toHaveLength(1);
        expect(remote.failedAssignmentRequests()).toBe(1);
        await eventually(async () => {
          const joins = await local.runtime.main.commit(
            (tx) =>
              tx.scanTasks(
                { conversationId: local.runtime.main.id, kind: "batty.remote-join" },
                100,
              ),
            context,
          );
          return (
            joins.items.length === 1 &&
            joins.items.every(
              (task) =>
                task.state.status === "terminal" && task.state.outcome.status === "completed",
            )
          );
        }, "durable await task completed after status resync, not merely session delivery");
        await eventually(
          async () =>
            JSON.stringify(local.runtime.remotes.messages(id)).includes("B final complete"),
          "terminal session history caught up independently of assignment result",
        );
        const history = local.runtime.remotes.messages(id);
        expect(JSON.stringify(history)).toContain("B final complete");
        const copied = filesIn(history).find((file) => file.name === "origin.txt");
        expect(copied).toBeDefined();
        expect([...new Set(filesIn(history).map((file) => file.name))].sort()).toEqual([
          "origin.txt",
          "selected-input.txt",
        ]);
        expect(remote.fileRequests).toHaveLength(2);
        expect(remote.fileRequests.every((url) => !/%2f/i.test(url))).toBe(true);
        expect(copied!.downloadUrl).toContain(`/api/sent-files/remote-${remote.id}/`);
        const segments = new URL(copied!.downloadUrl, local.url).pathname
          .split("/")
          .slice(-4)
          .map(decodeURIComponent);
        const stored = await resolveSentFile({
          rootDir: local.config.sentFilesDir,
          workspaceId: segments[0]!,
          sessionId: segments[1]!,
          toolCallId: segments[2]!,
          fileId: segments[3]!,
        });
        await remote.close();
        local.runtime.remotes.disconnect(remote.id);
        expect(await readFile(stored.storedPath, "utf8")).toBe("tools executed on b");
        expect(JSON.stringify(local.runtime.remotes.messages(id))).toContain("B final complete");
        await local.close();
        // Reopen A without reconnecting to B: projections and bytes are local durable state.
        const reopened = await Runtime.open(local.config, { resume: false });
        try {
          reopened.remotes.disconnect(remote.id);
          expect(JSON.stringify(reopened.remotes.messages(id))).toContain("B final complete");
          expect(await readFile(stored.storedPath, "utf8")).toBe("tools executed on b");
        } finally {
          await reopened.close();
        }
      } finally {
        if (b) await writeFile(join(b.work, "release"), "release");
        await a?.close();
        await b?.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    45_000,
  );

  test.each(["/", "/batty/"])(
    "%s reverse-only Mac without a self URL supports workers, inspect, await, stop and restart",
    async (baseUrl) => {
      const directory = await mkdtemp(join(storageRoot, "batty-reverse-only-"));
      let windows: Awaited<ReturnType<typeof openInstance>> | undefined;
      let mac: Awaited<ReturnType<typeof openInstance>> | undefined;
      try {
        windows = await openInstance(directory, "a", 200, baseUrl);
        mac = await openInstance(directory, "b", 200, baseUrl);
        const local = windows;
        const remote = mac;
        await connectReverse(local, remote);
        // The adder supplies no address. A creator attempting a direct dial cannot
        // discover the fixture listener and must fail rather than hiding a fallback.
        expect(local.runtime.remotes.connection(remote.id)).not.toHaveProperty("url");
        const discovered = await local.runtime.remotes.workspaces(remote.id);
        expect(discovered[0]).toMatchObject({
          nodeId: remote.id,
          defaultModel: "faux/model-b",
          workspaces: [expect.objectContaining({ id: "work" })],
        });
        remote.faux.setResponses([
          fauxAssistantMessage(
            [
              fauxToolCall("bash", {
                command:
                  "printf ready > entered; for i in $(seq 1 400); do test -f release && exit 0; sleep 0.05; done; exit 1",
              }),
            ],
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage([fauxText("worker released")]),
        ]);
        const command = <T>(requestId: string, action: Record<string, unknown>) =>
          nodeRequest<T>(
            local.runtime.remotes.connection(remote.id),
            "node.command",
            { requestId, command: action },
            local.runtime.remotes.requestNode,
          );
        const run = { action: "run", workspaceId: "work", prompt: "native reverse-only worker" };
        const started = await command<{ output: Array<{ text: string }> }>("reverse-once", run);
        const session = /Session ID: (\d+)/.exec(started.output[0]!.text)![1]!;
        const duplicate = await command("reverse-once", run);
        expect(duplicate).toEqual(started);
        await eventually(async () => {
          try {
            return (await readFile(join(remote.work, "entered"), "utf8")) === "ready";
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
          }
        }, "reverse-only native bash worker");
        const inspected = await command<{ output: Array<{ text: string }> }>("reverse-inspect", {
          action: "inspect",
          sessionId: session,
        });
        expect(JSON.parse(inspected.output[0]!.text)).toMatchObject({
          sessionId: session,
          status: "running",
        });
        const waiting = await command<{ details: { assignmentId: string } }>("reverse-await", {
          action: "await",
          sessionId: session,
        });
        const controller = new AbortController();
        const joined = local.runtime.remotes.join(
          {
            node: remote.id,
            session,
            assignmentId: waiting.details.assignmentId,
            parentId: local.runtime.main.id,
          },
          controller.signal,
        );
        try {
          await local.runtime.remotes.stop(`remote:${remote.id}:${session}`);
          await joined;
          await eventually(
            async () => (await remote.runtime.orchestration.listRunning()).length === 0,
            "stopped remote worker",
          );
          const after = await command<{ output: Array<{ text: string }> }>(
            "reverse-inspect-stopped",
            {
              action: "inspect",
              sessionId: session,
            },
          );
          expect(JSON.parse(after.output[0]!.text).status).not.toBe("running");
          expect(await transcript(local.runtime)).toContain(`remote:${remote.id}:${session}`);
          const installation = remote.runtime.remotes.access.identity().instanceId;
          await remote.close();
          await eventually(
            async () => local.runtime.remotes.reverse.status(remote.id).state !== "connected",
            "closed Mac transport becoming unavailable",
          );
          mac = await openInstance(directory, "b", 200, baseUrl);
          expect(mac.runtime.remotes.access.identity().instanceId).toBe(installation);
          const reopened = mac;
          await eventually(
            async () =>
              local.runtime.remotes.reverse.status(remote.id).state === "connected" &&
              reopened.runtime.remotes.reverse.status(local.id).state === "connected",
            "persisted Mac pairing reconnecting after Runtime/server restart",
          );
          const restored = await command<{ output: Array<{ text: string }> }>("reverse-restored", {
            action: "inspect",
            sessionId: session,
          });
          expect(JSON.parse(restored.output[0]!.text)).toMatchObject({ sessionId: session });
          expect((await local.runtime.remotes.workspaces(remote.id))[0]!.defaultModel).toBe(
            "faux/model-b",
          );
          const catalog = await reopened.runtime.orchestration.queryWorkers({
            action: "list",
            status: "all",
          });
          expect(JSON.parse(catalog.output[0]!.text).workers).toHaveLength(1);
        } finally {
          controller.abort();
          await joined.catch(() => {});
        }
      } finally {
        if (mac) await writeFile(join(mac.work, "release"), "release");
        await windows?.close();
        await mac?.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test("pending remote await settles after connection removal persistence without another remote commit", async () => {
    const directory = await mkdtemp(join(storageRoot, "batty-remote-remove-await-"));
    let windows: Awaited<ReturnType<typeof openInstance>> | undefined;
    let mac: Awaited<ReturnType<typeof openInstance>> | undefined;
    try {
      windows = await openInstance(directory, "a");
      mac = await openInstance(directory, "b");
      const local = windows;
      const remote = mac;
      await connect(local, remote);
      remote.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("bash", {
              command:
                "printf ready > entered; for i in $(seq 1 400); do test -f release && exit 0; sleep 0.05; done; exit 1",
            }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage([fauxText("released removal regression")]),
      ]);
      const connection = local.runtime.remotes.connection(remote.id);
      const command = <T>(requestId: string, body: Record<string, unknown>) =>
        nodeRequest<T>(
          connection,
          "node.command",
          { requestId, command: body },
          local.runtime.remotes.requestNode,
        );
      const started = await command<{ output: Array<{ text: string }> }>("removal-run", {
        action: "run",
        workspaceId: "work",
        prompt: "hold while parent connection is removed",
      });
      const session = /Session ID: (\d+)/.exec(started.output[0]!.text)![1]!;
      const waiting = await command<{ details: { assignmentId: string } }>("removal-await", {
        action: "await",
        sessionId: session,
      });
      // Removing a connection must wake a durable await after persistence, not before.
      const joinAbort = new AbortController();
      let joined = false;
      const pendingJoin = local.runtime.remotes
        .join(
          {
            node: remote.id,
            session,
            assignmentId: waiting.details.assignmentId,
            parentId: local.runtime.main.id,
          },
          joinAbort.signal,
        )
        .then(() => {
          joined = true;
        });
      let releaseRemoval!: () => void;
      const removalGate = new Promise<void>((resolve) => {
        releaseRemoval = resolve;
      });
      let enteredRemoval!: () => void;
      const removalEntered = new Promise<void>((resolve) => {
        enteredRemoval = resolve;
      });
      const originalRemove = local.runtime.remotes.access.removeConnection.bind(
        local.runtime.remotes.access,
      );
      const remove = vi
        .spyOn(local.runtime.remotes.access, "removeConnection")
        .mockImplementation(async (node) => {
          enteredRemoval();
          await removalGate;
          return originalRemove(node);
        });
      try {
        const removing = local.app
          .inject({
            method: "POST",
            url: "/api/remotes",
            headers: local.owner,
            payload: { action: "connection-remove", id: remote.id },
          })
          .then((response) => response);
        await removalEntered;
        expect(local.runtime.remotes.access.getConnection(remote.id)).toBeDefined();
        expect(joined).toBe(false);
        releaseRemoval();
        expect((await removing).statusCode).toBe(200);
        await pendingJoin;
        expect(await transcript(local.runtime)).toContain(`Unknown remote instance: ${remote.id}`);
        expect(local.runtime.remotes.access.getConnection(remote.id)).toBeUndefined();
        // Unpairing settles the coordinator's await, not the peer's independent worker.
        // Finish its persistent shell before tearing down the fixture directory.
        await writeFile(join(remote.work, "release"), "release");
        await eventually(
          async () => (await remote.runtime.orchestration.listRunning()).length === 0,
          "original worker completes after connection removal",
        );
      } finally {
        releaseRemoval();
        joinAbort.abort();
        await pendingJoin.catch(() => {});
        remove.mockRestore();
      }
    } finally {
      if (mac) await writeFile(join(mac.work, "release"), "release");
      await windows?.close();
      await mac?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  // A permanent miss and a retryable failure exercise the two import/recovery paths.

  test("a local assigned worker awaits its remote child without completing its original parent assignment early", async () => {
    const directory = await mkdtemp(join(storageRoot, "batty-remote-nested-await-"));
    let a: Awaited<ReturnType<typeof openInstance>> | undefined;
    let b: Awaited<ReturnType<typeof openInstance>> | undefined;
    try {
      a = await openInstance(directory, "a");
      b = await openInstance(directory, "b");
      const local = a;
      const remote = b;
      await connect(local, remote);
      remote.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("bash", {
              command:
                "printf ready > entered; for i in $(seq 1 400); do test -f release && exit 0; sleep 0.05; done; exit 1",
            }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage([fauxText("B nested child finished")]),
      ]);
      let bridgeId: string | undefined;
      let remoteId: string | undefined;
      let continued = false;
      local.faux.setResponses(
        Array.from({ length: 30 }, () => (request) => {
          const last = request.messages.findLast((message) => message.role !== "system")!;
          const content = JSON.stringify(last);
          if (last.role === "toolResult" && last.toolName === "subagent") {
            const id = /Session ID: (remote:[\w-]+:\d+|\d+)/.exec(content)?.[1];
            if (id?.startsWith("remote:")) {
              remoteId = id;
              return fauxAssistantMessage(
                [fauxToolCall("subagent", { action: "await", sessionId: id })],
                { stopReason: "toolUse" },
              );
            }
            if (id) bridgeId = id;
            return fauxAssistantMessage([fauxText("A main waiting for local bridge")]);
          }
          if (last.role === "user" && content.includes("B nested child finished")) {
            continued = true;
            return fauxAssistantMessage([fauxText("Local bridge completed after B")]);
          }
          if (last.role === "user" && content.includes("[subagent"))
            return fauxAssistantMessage([fauxText("A main received local bridge result")]);
          if (last.role === "user" && content.includes("local bridge child"))
            return fauxAssistantMessage(
              [
                fauxToolCall("subagent", {
                  action: "run",
                  nodeId: remote.id,
                  workspaceId: "work",
                  prompt: "B nested task",
                }),
              ],
              { stopReason: "toolUse" },
            );
          return fauxAssistantMessage(
            [
              fauxToolCall("subagent", {
                action: "run",
                workspaceId: "work",
                prompt: "local bridge child",
              }),
            ],
            { stopReason: "toolUse" },
          );
        }),
      );
      await (
        await local.runtime.main.submit(
          { type: "input", content: "Start nested integration" },
          context,
        )
      ).wait(context);
      await eventually(
        async () => Boolean(bridgeId && remoteId),
        "local bridge awaiting remote child",
      );
      await eventually(async () => {
        const bridge = await local.runtime.orchestration.metadata(
          (await local.runtime.conversation(bridgeId!)).id,
        );
        return Object.keys(bridge?.completion?.waits ?? {}).some((key) =>
          key.startsWith(`remote:${remote.id}:`),
        );
      }, "remote wait recorded on local assignment completion");
      expect(continued).toBe(false);
      expect(await transcript(local.runtime)).not.toContain("Local bridge completed after B");
      const active = await local.runtime.orchestration.listRunning();
      expect(active.some((item) => item.sessionId === bridgeId)).toBe(true);
      expect((await remote.runtime.main.context(context)).messages).toHaveLength(0);
      await writeFile(join(remote.work, "release"), "release");
      await eventually(
        async () => (await transcript(local.runtime)).includes("Local bridge completed after B"),
        "local original assignment finishing after remote result",
      );
      expect(continued).toBe(true);
      await eventually(
        async () => (await local.runtime.orchestration.listRunning()).length === 0,
        "local bridge completion",
      );
      expect((await remote.runtime.main.context(context)).messages).toHaveLength(0);
      const bridge = await local.runtime.conversation(bridgeId!);
      const state = await local.runtime.state(String(bridge.id));
      expect(JSON.stringify(state.messages)).toContain("B nested child finished");
      expect(JSON.stringify(state.messages)).toContain("Local bridge completed after B");
      const parentEntries = JSON.parse(await transcript(local.runtime)) as Array<{
        model?: Array<{ role: string; content: unknown }>;
      }>;
      expect(
        parentEntries
          .flatMap((entry) => entry.model ?? [])
          .filter(
            (message) =>
              message.role === "user" &&
              JSON.stringify(message.content).includes("Local bridge completed after B"),
          ),
      ).toHaveLength(1);
    } finally {
      if (b) await writeFile(join(b.work, "release"), "release");
      await Promise.all([a?.close(), b?.close()]);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
}
