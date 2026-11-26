import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { NodePresentation } from "../shared/node-api";
import { join } from "node:path";
import { expect, vi } from "vite-plus/test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { context } from "./runtime";
import { resolveSentFile } from "./send-files";
import {
  test,
  storageRoot,
  eventually,
  openInstance,
  connect,
  connectReverse,
  transcript,
  filesIn,
  importedRef,
  withSelectedFiles,
} from "./remote-workers.integration-fixtures";

export function registerRemoteWorkerFilesTests() {
  test.each([404, 503])(
    "native file failure %i does not strand a coordinator's remote await or terminal mirror",
    async (status) => {
      const directory = await mkdtemp(join(storageRoot, "batty-remote-import-failure-"));
      let a: Awaited<ReturnType<typeof openInstance>> | undefined;
      let b: Awaited<ReturnType<typeof openInstance>> | undefined;
      try {
        a = await openInstance(directory, "a");
        b = await openInstance(directory, "b", status);
        const local = a;
        const remote = b;
        await connect(local, remote);
        remote.faux.setResponses([
          fauxAssistantMessage([fauxToolCall("import_files", { paths: ["origin.txt"] })], {
            stopReason: "toolUse",
          }),
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
              withSelectedFiles(
                "Remote final despite missing attachment",
                importedRef(request, "origin.txt"),
              ),
            ]),
        ]);
        // A project worker has the same remote coordination access as main.
        await mkdir(join(directory, "a", "project"));
        let started = false;
        let remoteStarted = false;
        let receivedImportFailure = false;
        local.faux.setResponses(
          Array.from({ length: 30 }, () => (request) => {
            if (!started) {
              started = true;
              return fauxAssistantMessage(
                [
                  fauxToolCall("subagent", {
                    action: "run",
                    workspaceId: "project",
                    prompt: "Coordinate remote evidence",
                  }),
                ],
                { stopReason: "toolUse" },
              );
            }
            const last = request.messages.findLast((message) => message.role !== "system");
            if (
              last?.role === "user" &&
              JSON.stringify(last).includes("Coordinate remote evidence") &&
              !remoteStarted
            ) {
              remoteStarted = true;
              return fauxAssistantMessage(
                [
                  fauxToolCall("subagent", {
                    action: "run",
                    nodeId: remote.id,
                    workspaceId: "work",
                    prompt: "Attach evidence and finish",
                  }),
                ],
                { stopReason: "toolUse" },
              );
            }
            if (last?.role === "toolResult" && last.toolName === "subagent") {
              const remoteId = /Session ID: (remote:[\w-]+:\d+)/.exec(JSON.stringify(last))?.[1];
              if (remoteId)
                return fauxAssistantMessage(
                  [fauxToolCall("subagent", { action: "await", sessionId: remoteId })],
                  { stopReason: "toolUse" },
                );
            }
            if (
              last?.role === "user" &&
              JSON.stringify(last).includes("Remote final despite missing attachment")
            ) {
              expect(JSON.stringify(last)).toContain("Remote file import failed");
              expect(JSON.stringify(last)).toContain(
                `Remote file ${status === 404 ? "NOT_FOUND" : "INTERNAL"}`,
              );
              receivedImportFailure = true;
            }
            return fauxAssistantMessage([fauxText("Coordinator finished")]);
          }),
        );
        await (
          await local.runtime.main.submit(
            { type: "input", content: "Start a coordinator" },
            context,
          )
        ).wait(context);
        await eventually(async () => {
          const workers = await local.runtime.orchestration.listRunning();
          for (const worker of workers) {
            const conversation = await local.runtime.conversation(worker.sessionId);
            if (
              JSON.stringify((await conversation.context(context)).messages).includes(
                "Awaiting subagent",
              )
            )
              return true;
          }
          return false;
        }, "coordinator awaiting remote");
        await writeFile(join(remote.work, "release"), "release");
        await eventually(
          async () => (await local.runtime.orchestration.listRunning()).length === 0,
          "coordinator delivery settling despite file failure",
        );
        await eventually(
          async () => local.runtime.remotes.list()[0]?.status === "completed",
          "terminal remote status",
        );
        const id = local.runtime.remotes.list()[0]!.sessionId;
        await eventually(
          async () =>
            JSON.stringify(local.runtime.remotes.messages(id)).includes(
              "Remote final despite missing attachment",
            ),
          "terminal history replay",
        );
        const history = JSON.stringify(local.runtime.remotes.messages(id));
        expect(history).toContain(`Remote file ${status === 404 ? "NOT_FOUND" : "INTERNAL"}`);
        expect(filesIn(local.runtime.remotes.messages(id))).toEqual([]);
        // Re-reading terminal assignment receipts retries transient errors, not 404s.
        const requestsBefore = remote.fileRequests.length;
        const mirror = local.runtime.remotes as unknown as {
          importPresentation(node: string, value: NodePresentation): Promise<NodePresentation>;
        };
        const terminal = (await remote.runtime.state(id.split(":")[2]!)).messages.findLast(
          (message) => message.role === "custom" && message.customType === "batty.remote-result",
        );
        const source =
          terminal?.role === "custom" && (terminal.data?.presentation as NodePresentation);
        expect(source).toBeTruthy();
        await mirror.importPresentation(remote.id, source as NodePresentation);
        await mirror.importPresentation(remote.id, source as NodePresentation);
        expect(remote.fileRequests.length - requestsBefore).toBe(status === 404 ? 0 : 2);
        if (status !== 404) {
          remote.setFileStatus(200);
          const recovered = await mirror.importPresentation(remote.id, source as NodePresentation);
          expect(filesIn(recovered).some((file) => file.name === "origin.txt")).toBe(true);
          expect(JSON.stringify(recovered)).not.toContain("importErrors");
          const recoveredRequests = remote.fileRequests.length;
          await mirror.importPresentation(remote.id, source as NodePresentation);
          expect(remote.fileRequests).toHaveLength(recoveredRequests);
        }
        expect(await transcript(local.runtime)).toContain("Coordinator finished");
        expect(receivedImportFailure).toBe(true);
      } finally {
        if (b) await writeFile(join(b.work, "release"), "release");
        await a?.close();
        await b?.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    45_000,
  );

  test.each(["cancel", "revoke"] as const)(
    "native upload %s during transfer never admits a worker and cleans staging",
    async (interruption) => {
      const directory = await mkdtemp(join(storageRoot, "batty-native-upload-interrupt-"));
      const remote = await openInstance(directory, "receiver");
      const sender = await openInstance(directory, "sender");
      try {
        await connect(sender, remote);
        const grant = sender.runtime.remotes.connection(remote.id);
        const admission = vi.spyOn(remote.runtime.orchestration, "nodeCommand");
        await mkdir(remote.config.sentFilesDir, { recursive: true });
        const bytes = Buffer.from("finish only after grant check");
        const files = [
          {
            name: "evidence.txt",
            size: bytes.length,
            mimeType: "text/plain",
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ];
        let writer!: ReadableStreamDefaultController<Uint8Array>;
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>(
          {
            start(controller) {
              writer = controller;
              controller.enqueue(bytes.subarray(0, 1));
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        );
        const controller = new AbortController();
        const pending = sender.runtime.remotes.requestNode(
          grant,
          "node.command",
          {
            requestId: `interrupt-${interruption}`,
            command: { action: "run", workspaceId: "work", prompt: "must not be admitted" },
            files,
          },
          { body, signal: controller.signal },
        );
        const outcome = pending.then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        );
        await eventually(async () => {
          const entries = await readdir(remote.config.sentFilesDir);
          for (const stage of entries.filter((name) => name.startsWith(".worker-input-"))) {
            try {
              if (
                (await readFile(join(remote.config.sentFilesDir, stage, "0", "evidence.txt")))
                  .length === 1
              )
                return true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
          return false;
        }, "first native upload chunk stored before interruption");
        if (interruption === "cancel") controller.abort(new Error("Cancelled native upload"));
        else {
          // Do not close the socket: domain admission must recheck after byte receipt.
          await remote.runtime.remotes.access.revoke(grant.grantId!);
          writer.enqueue(bytes.subarray(1));
          writer.close();
        }
        const { error } = await outcome;
        if (interruption === "cancel")
          expect(error).toMatchObject({ message: "Cancelled native upload" });
        else expect(error).toMatchObject({ code: "UNAUTHORIZED" });
        await eventually(async () => {
          const entries = await readdir(remote.config.sentFilesDir);
          return !entries.some((name) => name.startsWith(".worker-input-"));
        }, "interrupted native upload staging removed");
        expect(admission).not.toHaveBeenCalled();
        expect(await remote.runtime.orchestration.listRunning()).toHaveLength(0);
        if (interruption === "cancel") expect(cancelled).toBe(true);
      } finally {
        await sender.close();
        await remote.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test.each(["forward", "reverse"] as const)(
    "%s socket run/queue/steer/resume carry selected paths and received refs, images, immutable queued bytes and locally mirrored input attachments",
    async (transport) => {
      const directory = await mkdtemp(join(storageRoot, "batty-input-files-"));
      let a: Awaited<ReturnType<typeof openInstance>> | undefined;
      let b: Awaited<ReturnType<typeof openInstance>> | undefined;
      try {
        a = await openInstance(directory, "a");
        b = await openInstance(directory, "b");
        const local = a;
        const remote = b;
        if (transport === "reverse") await connectReverse(local, remote);
        else await connect(local, remote);
        const source = join(local.work, "evidence.txt");
        const image = join(local.work, "drawing.png");
        const binary = join(local.work, "large.bin");
        const binaryBytes = Buffer.allocUnsafe(2 * 1024 * 1024 + 137);
        for (let index = 0; index < binaryBytes.length; index++) binaryBytes[index] = index % 251;
        const binaryHash = createHash("sha256").update(binaryBytes).digest("hex");
        await writeFile(binary, binaryBytes);
        const png = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC",
          "base64",
        );
        await writeFile(source, "original sender bytes");
        await writeFile(image, png);
        let next: Record<string, import("@earendil-works/chord/json").JsonValue> = {};
        let id: string | undefined;
        let parentSequence = 0;
        let pendingParent = "";
        local.faux.setResponses(
          Array.from({ length: 80 }, () => (request) => {
            const last = request.messages.findLast((message) => message.role !== "system")!;
            const text = JSON.stringify(last.content);
            if (last.role === "user" && text.includes("seed-parent-ref"))
              return fauxAssistantMessage([fauxToolCall("import_files", { paths: [source] })], {
                stopReason: "toolUse",
              });
            if (
              pendingParent &&
              request.messages.some(
                (message) =>
                  message.role === "user" &&
                  JSON.stringify(message.content).includes(pendingParent),
              )
            ) {
              pendingParent = "";
              return fauxAssistantMessage([fauxToolCall("subagent", next)], {
                stopReason: "toolUse",
              });
            }
            if (last.role === "toolResult" && last.toolName === "subagent")
              id ??= /Session ID: (remote:[\w-]+:\d+)/.exec(text)?.[1];
            return fauxAssistantMessage([fauxText("parent acknowledged")]);
          }),
        );
        const received: Array<{
          phase: string;
          bytes: string;
          image: boolean;
          path: string;
          binaryHash: string;
        }> = [];
        remote.faux.setResponses(
          Array.from({ length: 40 }, () => (request) => {
            const last = request.messages.findLast((message) => message.role !== "system")!;
            if (last.role === "user") {
              const blocks =
                typeof last.content === "string"
                  ? [{ type: "text" as const, text: last.content }]
                  : last.content;
              const text = blocks
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("\n");
              const phase = /remote-phase-(run|queue|steer|resume)/.exec(text)?.[1];
              if (phase) {
                const path = /path="([^"]+)"/.exec(text)![1]!;
                expect(path).toContain(remote.config.sentFilesDir);
                expect(text).not.toContain(source);
                expect(text).not.toContain("<batty-runtime-notice>");
                received.push({
                  phase,
                  path,
                  bytes: readFileSync(path, "utf8"),
                  binaryHash: createHash("sha256")
                    .update(
                      readFileSync(
                        [...text.matchAll(/path="([^"]+)"/g)]
                          .map((match) => match[1]!)
                          .find((value) => value.endsWith("large.bin"))!,
                      ),
                    )
                    .digest("hex"),
                  image: blocks.some(
                    (block) => block.type === "image" && block.data === png.toString("base64"),
                  ),
                });
                if (phase === "run")
                  return fauxAssistantMessage(
                    [
                      fauxToolCall("bash", {
                        command:
                          "printf ready > input-entered; for i in $(seq 1 400); do test -f input-release && exit 0; sleep 0.05; done; exit 1",
                      }),
                    ],
                    { stopReason: "toolUse" },
                  );
              }
            }
            return fauxAssistantMessage([fauxText("remote file assignment complete")]);
          }),
        );
        const parent = async (content: string) => {
          if (content === "parent-command")
            content = pendingParent = `parent-command-${++parentSequence}`;
          await (
            await local.runtime.main.submit({ type: "input", content }, context)
          ).wait(context);
        };
        await parent("seed-parent-ref");
        const ref = importedRef(await local.runtime.main.context(context), "evidence.txt");
        const send = async (action: string, phase: string, useRef = false) => {
          next = {
            action,
            ...(id ? { sessionId: id } : { nodeId: remote.id, workspaceId: "work" }),
            prompt: `remote-phase-${phase}`,
            files: [useRef ? { ref } : { path: source }, { path: image }, { path: binary }],
          };
          await parent("parent-command");
          const result = (await local.runtime.main.context(context)).messages.findLast(
            (message) => message.role === "toolResult" && message.toolName === "subagent",
          );
          expect(result, JSON.stringify(result)).toMatchObject({ isError: false });
        };
        await send("run", "run", true);
        await eventually(async () => {
          try {
            await readFile(join(remote.work, "input-entered"));
            return true;
          } catch {
            return false;
          }
        }, "remote input hold");
        await send("queue", "queue");
        await writeFile(source, "changed after queue");
        await send("steer", "steer");
        await writeFile(source, "changed after steer");
        await writeFile(join(remote.work, "input-release"), "release");
        await eventually(
          async () => (await remote.runtime.orchestration.listRunning()).length === 0,
          "queued remote file assignments",
        );
        expect(received.map(({ phase, bytes, image }) => ({ phase, bytes, image }))).toEqual([
          { phase: "run", bytes: "original sender bytes", image: true },
          { phase: "steer", bytes: "changed after queue", image: true },
          { phase: "queue", bytes: "original sender bytes", image: true },
        ]);
        await send("resume", "resume");
        await eventually(
          async () => (await remote.runtime.orchestration.listRunning()).length === 0,
          "resumed remote input assignment",
        );
        expect(received.every((entry) => entry.binaryHash === binaryHash)).toBe(true);
        expect(received.at(-1)).toMatchObject({
          phase: "resume",
          bytes: "changed after steer",
          image: true,
        });
        await eventually(async () => {
          try {
            return filesIn(local.runtime.remotes.state(id!)).length >= 8;
          } catch {
            return false;
          }
        }, "locally imported input attachments");
        const mirrored = filesIn(local.runtime.remotes.state(id!));
        expect(mirrored.some((file) => file.name === "large.bin")).toBe(true);
        expect(mirrored.map((file) => new URL(file.downloadUrl, local.url).pathname)).toEqual(
          expect.arrayContaining([expect.stringContaining(`/api/sent-files/remote-${remote.id}/`)]),
        );
        expect(mirrored.map((file) => new URL(file.downloadUrl, local.url).pathname)).toEqual(
          mirrored.map(() => expect.stringContaining(`/api/sent-files/remote-${remote.id}/`)),
        );
        for (const file of mirrored) {
          const match = /\/api\/sent-files\/([^/]+)\/([^/]+)\/([^/]+)\/([^/?]+)/.exec(
            file.downloadUrl,
          )!;
          const resolved = await resolveSentFile({
            rootDir: local.config.sentFilesDir,
            workspaceId: match[1]!,
            sessionId: match[2]!,
            toolCallId: match[3]!,
            fileId: match[4]!,
          });
          const bytes = await readFile(resolved.storedPath);
          expect(bytes.length).toBeGreaterThan(0);
          if (file.name === "large.bin") expect(bytes).toEqual(binaryBytes);
        }
      } finally {
        if (b) await writeFile(join(b.work, "input-release"), "release");
        await a?.close();
        await b?.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
}
