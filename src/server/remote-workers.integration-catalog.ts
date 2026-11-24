import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect, test as serialTest, vi } from "vite-plus/test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { context } from "./runtime";
import {
  test,
  storageRoot,
  eventually,
  openInstance,
  connect,
  transcript,
} from "./remote-workers.integration-fixtures";

export function registerRemoteWorkerCatalogTests() {
  test("catalog skips historical worker streams and retires active streams until the worker resumes", async ({
    expect,
  }) => {
    const directory = await mkdtemp(join(storageRoot, "batty-remote-stream-lifecycle-"));
    let a: Awaited<ReturnType<typeof openInstance>> | undefined;
    let b: Awaited<ReturnType<typeof openInstance>> | undefined;
    try {
      a = await openInstance(directory, "a");
      b = await openInstance(directory, "b");
      const local = a;
      const remote = b;
      remote.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("subagent", {
              action: "run",
              workspaceId: "work",
              prompt: "Historical local worker",
            }),
          ],
          { stopReason: "toolUse" },
        ),
        ...Array.from({ length: 10 }, () =>
          fauxAssistantMessage([fauxText("Historical worker completed")]),
        ),
      ]);
      await (
        await remote.runtime.main.submit(
          { type: "input", content: "Create a native historical worker" },
          context,
        )
      ).wait(context);
      await eventually(
        async () => (await remote.runtime.orchestration.listRunning()).length === 0,
        "native historical worker finishing",
      );
      const discovered = await remote.runtime.orchestration.nodeCommand(
        "fixture",
        "historical-list",
        { action: "list", status: "all" },
      );
      const historical = JSON.parse((discovered.output as Array<{ text: string }>)[0]!.text)
        .workers as Array<{ sessionId: string; status: string }>;
      expect(historical).toHaveLength(1);
      expect(historical[0]!.status).toBe("completed");
      const historicalId = historical[0]!.sessionId;

      await connect(local, remote);
      await eventually(
        async () =>
          local.runtime.remotes
            .list()
            .some((worker) => worker.sessionId === `remote:${remote.id}:${historicalId}`),
        "historical worker discovery",
      );
      expect(remote.sessionStreams).toHaveLength(0);
      const streamsFor = (id: string) =>
        remote.sessionStreams.filter((stream) => stream.url === `node.session.watch:${id}`);
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
        fauxAssistantMessage([fauxText("Active stream first terminal result")]),
      ]);
      local.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("subagent", {
              action: "run",
              nodeId: remote.id,
              workspaceId: "work",
              prompt: "Active streaming worker",
            }),
          ],
          { stopReason: "toolUse" },
        ),
        ...Array.from({ length: 10 }, () =>
          fauxAssistantMessage([fauxText("Observed remote lifecycle")]),
        ),
      ]);
      await (
        await local.runtime.main.submit(
          { type: "input", content: "Start active remote worker" },
          context,
        )
      ).wait(context);
      await eventually(
        async () => remote.sessionStreams.some((stream) => !stream.closed),
        "active worker event stream opening",
      );
      const active = local.runtime.remotes
        .list()
        .find((worker) => worker.sessionId !== `remote:${remote.id}:${historicalId}`)!;
      expect(active).toBeDefined();
      const sessionId = active.sessionId.split(":")[2]!;
      expect(streamsFor(sessionId)).toHaveLength(1);
      expect(streamsFor(sessionId)[0]!.closed).toBe(false);
      await writeFile(join(remote.work, "release"), "release");
      // Opening the remote HTTP stream precedes importing its first snapshot locally.
      // Poll through the expected 404 until the terminal history has been mirrored.
      await expect
        .poll(() => JSON.stringify(local.runtime.remotes.messages(active.sessionId)), {
          timeout: 15_000,
        })
        .toContain("Active stream first terminal result");
      await eventually(
        async () => streamsFor(sessionId)[0]!.closed,
        "terminal session stream retiring",
      );
      expect((await local.runtime.state(active.sessionId)).isStreaming).toBe(false);
      expect(
        local.runtime.remotes.list().find((worker) => worker.sessionId === active.sessionId)
          ?.status,
      ).toBe("completed");

      remote.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("bash", {
              command:
                "printf ready > entered-resume; for i in $(seq 1 400); do test -f release-resume && exit 0; sleep 0.05; done; exit 1",
            }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage([fauxText("Resumed stream second terminal result")]),
      ]);
      local.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("subagent", {
              action: "resume",
              sessionId: active.sessionId,
              prompt: "Resume remote streaming worker",
            }),
          ],
          { stopReason: "toolUse" },
        ),
        ...Array.from({ length: 10 }, () =>
          fauxAssistantMessage([fauxText("Observed resumed remote lifecycle")]),
        ),
      ]);
      await (
        await local.runtime.main.submit(
          { type: "input", content: "Resume the completed remote worker" },
          context,
        )
      ).wait(context);
      await eventually(
        async () => streamsFor(sessionId).length === 2,
        "resumed worker event stream reopening",
      );
      const resumedStream = streamsFor(sessionId)[1]!;
      expect(resumedStream.closed).toBe(false);
      expect(new URL(resumedStream.url, remote.url).searchParams.get("after")).not.toBe("0");
      await eventually(
        async () => (await local.runtime.state(active.sessionId)).isStreaming,
        "resumed worker active projection",
      );
      await writeFile(join(remote.work, "release-resume"), "release");
      await eventually(
        async () =>
          JSON.stringify(local.runtime.remotes.messages(active.sessionId)).includes(
            "Resumed stream second terminal result",
          ),
        "resumed terminal history mirrored",
      );
      await eventually(async () => resumedStream.closed, "resumed terminal stream retiring");
      expect(streamsFor(sessionId)).toHaveLength(2);
      expect(streamsFor(historicalId)).toHaveLength(0);
      expect(JSON.stringify(local.runtime.remotes.messages(active.sessionId))).toContain(
        "Active stream first terminal result",
      );
    } finally {
      if (b) {
        await writeFile(join(b.work, "release"), "release");
        await writeFile(join(b.work, "release-resume"), "release");
      }
      await Promise.all([a?.close(), b?.close()]);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("terminal metadata cannot retire a stream before its committed result cursor is mirrored", async () => {
    const directory = await mkdtemp(join(storageRoot, "batty-remote-terminal-cursor-"));
    let a: Awaited<ReturnType<typeof openInstance>> | undefined;
    let b: Awaited<ReturnType<typeof openInstance>> | undefined;
    let restoreState: (() => void) | undefined;
    const heldReads = Promise.withResolvers<void>();
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
        fauxAssistantMessage([fauxText("Cursor race final result")]),
      ]);
      local.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("subagent", {
              action: "run",
              nodeId: remote.id,
              workspaceId: "work",
              prompt: "Exercise terminal cursor race",
            }),
          ],
          { stopReason: "toolUse" },
        ),
        ...Array.from({ length: 10 }, () =>
          fauxAssistantMessage([fauxText("Observed cursor race worker")]),
        ),
      ]);
      let targetSession: string | undefined;
      let injected = false;
      let staleCursor: string | undefined;
      let resultCursor: number | undefined;
      let catchupReadEntered = false;
      const nativeState = remote.runtime.state.bind(remote.runtime);
      const stateSpy = vi.spyOn(remote.runtime, "state").mockImplementation(async (...args) => {
        const state = await nativeState(...args);
        if (args[0] !== targetSession || !args[2]) return state;
        const final = state.messages.find(
          (message) => message.role === "custom" && message.customType === "batty.remote-result",
        );
        if (!final || state.isStreaming || state.canStopSubagent) return state;
        if (!injected) {
          injected = true;
          resultCursor = Number(final.id.split(":")[0]);
          const earlier = state.messages.filter(
            (message) => Number(message.id.split(":")[0]) < resultCursor!,
          );
          staleCursor = String(
            Math.max(
              Number(args[3] ?? 0),
              ...earlier.map((message) => Number(message.id.split(":")[0])),
            ),
          );
          // Simulate live metadata being read after completion, but the history boundary before it.
          return {
            ...state,
            messages: earlier,
            historyCursor: staleCursor,
            hasMoreRecentMessages: false,
            isStreaming: false,
            canStopSubagent: false,
          };
        }
        // Keep the catch-up observable, rather than letting a concurrent flush hide the split snapshot.
        catchupReadEntered = true;
        await heldReads.promise;
        return state;
      });
      restoreState = () => stateSpy.mockRestore();
      await (
        await local.runtime.main.submit(
          { type: "input", content: "Start terminal cursor race" },
          context,
        )
      ).wait(context);
      await eventually(
        async () => local.runtime.remotes.list().length === 1 && remote.sessionStreams.length === 1,
        "race worker stream opening",
      );
      const mirroredId = local.runtime.remotes.list()[0]!.sessionId;
      targetSession = mirroredId.split(":")[2]!;
      await writeFile(join(remote.work, "release"), "release");
      await eventually(async () => {
        if (!injected) return false;
        const state = await local.runtime.state(mirroredId);
        const summary = local.runtime.remotes.list()[0]!;
        return (
          !state.isStreaming &&
          !state.canStopSubagent &&
          state.historyCursor === staleCursor &&
          Number(summary.terminalCursor) >= resultCursor!
        );
      }, "stale terminal snapshot mirrored below the authoritative catalog cursor");
      expect(Number(staleCursor)).toBeLessThan(resultCursor!);
      expect(await transcript(local.runtime)).not.toContain("Cursor race final result");
      const worker = await remote.runtime.conversation(targetSession);
      await worker.commit(
        (tx) => tx.appendEntry(worker.id, { kind: "test.terminal-cursor-refresh" }),
        context,
      );
      await eventually(
        async () => catchupReadEntered,
        "same stream requesting the missing journal tail",
      );
      expect(remote.sessionStreams).toHaveLength(1);
      expect(remote.sessionStreams[0]!.closed).toBe(false);
      heldReads.resolve();
      await eventually(
        async () => (await transcript(local.runtime)).includes("Cursor race final result"),
        "committed final result delivered after cursor catch-up",
      );
      await eventually(
        async () => remote.sessionStreams[0]!.closed,
        "stream retiring only after final cursor catch-up",
      );
      expect((await transcript(local.runtime)).match(/Cursor race final result/g)).toHaveLength(1);
      expect(JSON.stringify(local.runtime.remotes.messages(mirroredId))).toContain(
        "batty.remote-result",
      );
      expect(remote.sessionStreams).toHaveLength(1);
    } finally {
      heldReads.resolve();
      restoreState?.();
      if (b) await writeFile(join(b.work, "release"), "release");
      await Promise.all([a?.close(), b?.close()]);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  // This case spies on global fetch; keep it outside the concurrent group.
  serialTest(
    "native binary commands verify admission, never use HTTP, deduplicate retries and recheck live grants",
    async () => {
      const directory = await mkdtemp(join(storageRoot, "batty-native-input-replay-"));
      const remote = await openInstance(directory, "receiver");
      const sender = await openInstance(directory, "sender");
      let restoreHttp = () => {};
      try {
        await connect(sender, remote);
        const grant = sender.runtime.remotes.connection(remote.id);
        const channel = sender.runtime.remotes.reverse.channel(grant);
        const originalFetch = globalThis.fetch;
        const http = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
          const url = new URL(
            typeof input === "string" ? input : input instanceof URL ? input : input.url,
          );
          if (url.pathname.startsWith("/api/node/"))
            throw new Error("Native peer traffic attempted HTTP");
          return originalFetch(input, init);
        });
        restoreHttp = () => http.mockRestore();
        let calls = 0;
        remote.faux.setResponses(
          Array.from({ length: 10 }, () => () => {
            calls++;
            return fauxAssistantMessage([fauxText("input processed")]);
          }),
        );
        const bytes = Buffer.from("durable input bytes");
        const metadata = [
          {
            name: "evidence.txt",
            size: bytes.length,
            mimeType: "text/plain",
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ];
        const command = {
          action: "run" as const,
          prompt: "process transferred input",
          workspaceId: "work",
        };
        const body = (value = bytes) =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(value);
              controller.close();
            },
          });
        const send = (requestId: string, files = metadata, value = bytes) =>
          sender.runtime.remotes.requestNode(
            grant,
            "node.command",
            { requestId, command, files },
            { body: body(value) },
          );
        await expect(
          send("attempt", [{ ...metadata[0]!, sha256: "0".repeat(64) }]),
        ).rejects.toMatchObject({ code: "BAD_INPUT" });
        await expect(send("missing", metadata, bytes.subarray(1))).rejects.toMatchObject({
          code: "BAD_INPUT",
        });
        await expect(
          send("extra", metadata, Buffer.concat([bytes, Buffer.from("extra")])),
        ).rejects.toMatchObject({ code: "BAD_INPUT" });
        expect(await remote.runtime.orchestration.listRunning()).toHaveLength(0);
        expect(calls).toBe(0);
        const receipt = (await send("attempt")).value;
        await eventually(
          async () => (await remote.runtime.orchestration.listRunning()).length === 0,
          "single native imported assignment",
        );
        expect((await send("attempt")).value).toEqual(receipt);
        expect(calls).toBe(1);
        await expect(
          sender.runtime.remotes.requestNode(
            grant,
            "node.command",
            {
              requestId: "attempt",
              command: { ...command, prompt: "different assignment" },
              files: metadata,
            },
            { body: body() },
          ),
        ).rejects.toThrow("reused with different arguments");
        await expect(
          channel.call("node.command", {
            requestId: "path-injection",
            command: { ...command, files: [{ path: join(remote.work, "origin.txt") }] },
          }),
        ).rejects.toMatchObject({ code: "BAD_INPUT" });
        await expect(channel.call("owner.settings", {})).rejects.toMatchObject({
          code: "FORBIDDEN",
        });
        await remote.runtime.remotes.access.revoke(grant.grantId!);
        // Keep the authenticated socket alive: revocation is checked on every call,
        // not merely during its opening handshake.
        await expect(
          channel.call("node.command", { requestId: "revoked", command }),
        ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
        expect(calls).toBe(1);
      } finally {
        restoreHttp();
        await sender.close();
        await remote.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
}
