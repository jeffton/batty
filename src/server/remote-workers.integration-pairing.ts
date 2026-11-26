import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, vi } from "vite-plus/test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { context } from "./runtime";
import { RpcError } from "../shared/rpc/channel";
import {
  test,
  storageRoot,
  nodeRequest,
  eventually,
  openInstance,
  rejectedSocket,
  connect,
  connectReverse,
  transcript,
  filesIn,
  importedRef,
  withSelectedFiles,
} from "./remote-workers.integration-fixtures";

export function registerRemoteWorkerPairingTests() {
  test.each(["/", "/batty/"])(
    "%s owner pairing works bidirectionally, never becomes a node bearer, and rejects replay or cross-binding",
    async (baseUrl) => {
      const directory = await mkdtemp(join(storageRoot, "batty-single-invitation-"));
      const windows = await openInstance(directory, "windows", 200, baseUrl);
      const mac = await openInstance(directory, "mac", 200, baseUrl);
      const other = await openInstance(directory, "other");
      try {
        expect(
          (
            await windows.app.inject({
              method: "POST",
              url: "/api/remotes",
              payload: { action: "token-generate" },
            })
          ).statusCode,
        ).toBe(401);
        const bad = await mac.app.inject({
          method: "POST",
          url: "/api/remotes",
          headers: mac.owner,
          payload: { action: "connection-add", url: windows.url, token: "wrong-token" },
        });
        expect(bad.statusCode).toBe(500);
        expect(mac.runtime.remotes.access.listConnections()).toEqual([]);
        expect(windows.runtime.remotes.access.listConnections()).toEqual([]);

        const invitation = await connectReverse(windows, mac);
        expect(mac.id).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
        expect(windows.runtime.remotes.connection(mac.id)).not.toHaveProperty("url");
        expect(mac.runtime.remotes.connection(windows.id).url).toBe(windows.url);
        expect(windows.pairingClaims[0]).not.toHaveProperty("url");
        expect(windows.config.baseUrl).toBe(baseUrl === "/" ? "/" : "/batty");
        expect(windows.runtime.remotes.access.identity().name).toMatch(
          new RegExp(` · ${windows.id.slice(0, 8)}$`),
        );
        const inviteAuth = { authorization: `Bearer ${invitation.token}` };
        expect(await rejectedSocket(windows.url, invitation.token, mac.id)).toBe(401);
        // A lost HTTP response may retry exactly the durable original claim.
        const original = windows.pairingClaims[0]!;
        const retry = await windows.app.inject({
          method: "POST",
          url: "/api/node/pair",
          headers: inviteAuth,
          payload: original,
        });
        expect(retry.statusCode, retry.body).toBe(200);
        for (const claim of [
          { ...original, instanceId: other.id },
          { ...original, remoteToken: original.localToken },
          { ...original, localGrantId: "different-grant" },
        ]) {
          const replay = await windows.app.inject({
            method: "POST",
            url: "/api/node/pair",
            headers: inviteAuth,
            payload: claim,
          });
          expect(replay.statusCode).toBeGreaterThanOrEqual(400);
        }
        await connect(other, windows);
        const otherToken = other.runtime.remotes.connection(windows.id).token;
        expect(await rejectedSocket(windows.url, otherToken, mac.id)).toBe(403);
        const unused = await windows.app.inject({
          method: "POST",
          url: "/api/remotes",
          headers: windows.owner,
          payload: { action: "token-generate" },
        });
        const revoked = await windows.app.inject({
          method: "POST",
          url: "/api/remotes",
          headers: windows.owner,
          payload: { action: "token-revoke", id: unused.json().id },
        });
        expect(revoked.statusCode).toBe(200);
        const claimedRevoked = await windows.app.inject({
          method: "POST",
          url: "/api/node/pair",
          headers: { authorization: `Bearer ${unused.json().token}` },
          payload: { ...original, instanceId: "new-peer" },
        });
        expect(claimedRevoked.statusCode).toBe(401);
        await eventually(
          async () => windows.runtime.remotes.reverse.status(mac.id).state === "connected",
          "unused invitation revocation preserves paired peers",
        );
        for (const [from, to] of [
          [windows, mac],
          [mac, windows],
        ] as const) {
          to.faux.setResponses([
            fauxAssistantMessage([fauxToolCall("import_files", { paths: ["origin.txt"] })], {
              stopReason: "toolUse",
            }),
            (request) =>
              fauxAssistantMessage([
                withSelectedFiles(`executed on ${to.id}`, importedRef(request, "origin.txt")),
              ]),
          ]);
          const started = await nodeRequest<{ output: Array<{ text: string }> }>(
            from.runtime.remotes.connection(to.id),
            "node.command",
            {
              requestId: `paired-${from.id}`,
              command: {
                action: "run",
                workspaceId: "work",
                prompt: "prove both directions",
              },
            },
            from.runtime.remotes.requestNode,
          );
          expect(started.output[0]!.text).toContain("Started");
          const session = /Session ID: (\d+)/.exec(started.output[0]!.text)![1]!;
          const waiting = await nodeRequest<{ details: { assignmentId: string } }>(
            from.runtime.remotes.connection(to.id),
            "node.command",
            {
              requestId: `paired-await-${from.id}`,
              command: { action: "await", sessionId: session },
            },
            from.runtime.remotes.requestNode,
          );
          const controller = new AbortController();
          try {
            await from.runtime.remotes.join(
              {
                node: to.id,
                session,
                assignmentId: waiting.details.assignmentId,
                parentId: from.runtime.main.id,
              },
              controller.signal,
            );
          } finally {
            controller.abort();
          }
          await eventually(
            async () => (await to.runtime.orchestration.listRunning()).length === 0,
            "paired native worker completion",
          );
          const source = filesIn((await to.runtime.state(session)).messages).find(
            (file) => file.name === "origin.txt",
          );
          expect(source).toBeDefined();
          const segments = new URL(source!.downloadUrl, to.url).pathname.split("/").slice(-4);
          const received = await from.runtime.remotes.requestNode(
            from.runtime.remotes.connection(to.id),
            "node.file",
            {
              workspaceId: decodeURIComponent(segments[0]!),
              sessionId: decodeURIComponent(segments[1]!),
              toolCallId: decodeURIComponent(segments[2]!),
              fileId: decodeURIComponent(segments[3]!),
              // File storage is server-owned; extra input cannot override its root.
              // @ts-expect-error Deliberately send an unknown wire field.
              rootDir: join(directory, "attacker-selected-root"),
            },
          );
          expect(received.body).toBeDefined();
          expect(await new Response(received.body).text()).toBe(
            `tools executed on ${to === windows ? "windows" : "mac"}`,
          );
        }
        for (const instance of [windows, mac])
          expect(instance.nativeCalls).toEqual(
            expect.arrayContaining([
              "node.identity",
              "node.command",
              "node.catalog.watch",
              "node.file",
            ]),
          );
        expect(await windows.runtime.orchestration.queryWorkers({ action: "list" })).toHaveProperty(
          "output",
        );
        const publicState = await windows.app.inject({
          url: "/api/remotes",
          headers: windows.owner,
        });
        expect(publicState.body).not.toContain(invitation.token);
        expect(publicState.body).not.toContain(original.localToken);
        expect(publicState.body).not.toContain(original.remoteToken);
        expect(publicState.body).not.toContain("localGrantId");
        expect(publicState.body).not.toContain("claimHash");
        if (baseUrl !== "/") {
          for (const instance of [windows, mac]) {
            expect(instance.proxyRequests).toContain("/batty/api/remotes");
            expect(instance.proxyRequests.every((url) => url.startsWith("/batty/api/"))).toBe(true);
          }
          expect(windows.proxyRequests).toContain("/batty/api/node/pair");
          expect(windows.proxyRequests).toContain("/batty/api/node/socket");
          // A missing prefix is genuinely unroutable at this proxy, not swallowed by
          // an in-memory mock that would hide incorrect peer request destinations.
          const unprefixed = await fetch(new URL("/api/remotes", windows.url), {
            headers: windows.owner,
          });
          expect(unprefixed.status).toBe(404);
          await unprefixed.body?.cancel();
          // Worker events and binary file bodies travel over the same upgraded channel.
          expect(windows.proxyRequests.some((url) => url.includes("/reverse/"))).toBe(false);
        }
      } finally {
        await other.close();
        await mac.close();
        await windows.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test.each(["creator", "adder"] as const)(
    "offline removal by %s revokes access without restarting a worker or repairing itself",
    async (removingSide) => {
      const directory = await mkdtemp(join(storageRoot, "batty-offline-unpair-"));
      const windows = await openInstance(directory, "windows");
      const mac = await openInstance(directory, "mac");
      try {
        await connectReverse(windows, mac);
        mac.faux.setResponses([
          fauxAssistantMessage(
            [
              fauxToolCall("bash", {
                command:
                  "printf ready > entered; for i in $(seq 1 400); do test -f release && exit 0; sleep 0.05; done; exit 1",
              }),
            ],
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage([fauxText("independent worker completed")]),
        ]);
        const connection = windows.runtime.remotes.connection(mac.id);
        const started = await nodeRequest<{ output: Array<{ text: string }> }>(
          connection,
          "node.command",
          {
            requestId: "offline-unpair-worker",
            command: { action: "run", workspaceId: "work", prompt: "continue while disconnected" },
          },
          windows.runtime.remotes.requestNode,
        );
        const session = /Session ID: (\d+)/.exec(started.output[0]!.text)![1]!;
        await eventually(async () => {
          try {
            return (await readFile(join(mac.work, "entered"), "utf8")) === "ready";
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
          }
        }, "worker began before network outage");
        windows.setNodeOnline(false);
        await eventually(
          async () => mac.runtime.remotes.reverse.status(windows.id).state !== "connected",
          "simulated standby",
        );
        const removing = removingSide === "creator" ? windows : mac;
        const peer = removingSide === "creator" ? mac : windows;
        const staleToken = peer.runtime.remotes.connection(removing.id).token;
        const removed = await removing.app.inject({
          method: "POST",
          url: "/api/remotes",
          headers: removing.owner,
          payload: { action: "connection-remove", id: peer.id },
        });
        expect(removed.statusCode, removed.body).toBe(200);
        expect(removing.runtime.remotes.access.getConnection(peer.id)).toBeUndefined();
        windows.setNodeOnline(true);
        expect(await rejectedSocket(removing.url, staleToken, peer.id)).toBe(401);
        expect(removing.runtime.remotes.access.listConnections()).toEqual([]);
        expect(await mac.runtime.orchestration.listRunning()).toHaveLength(1);
        await writeFile(join(mac.work, "release"), "release");
        await eventually(
          async () => (await mac.runtime.orchestration.listRunning()).length === 0,
          "original worker completes after unpair",
        );
        const workers = await mac.runtime.orchestration.queryWorkers({
          action: "list",
          status: "all",
        });
        expect(JSON.parse(workers.output[0]!.text).workers).toEqual([
          expect.objectContaining({ sessionId: session, status: "completed" }),
        ]);
        expect(removing.runtime.remotes.access.listConnections()).toEqual([]);
      } finally {
        await writeFile(join(mac.work, "release"), "release");
        await mac.close();
        await windows.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test.each(["reverse-unpair", "control-loss"] as const)(
    "native paired catalog and session streams close on %s",
    async (interruption) => {
      const directory = await mkdtemp(join(storageRoot, "batty-paired-direct-streams-"));
      const windows = await openInstance(directory, "windows");
      const mac = await openInstance(directory, "mac");
      const readers: ReadableStreamDefaultReader<unknown>[] = [];
      const controllers: AbortController[] = [];
      try {
        await connectReverse(windows, mac);
        mac.faux.setResponses([
          fauxAssistantMessage(
            [
              fauxToolCall("bash", {
                command:
                  "printf ready > entered; for i in $(seq 1 400); do test -f release && exit 0; sleep 0.05; done; exit 1",
              }),
            ],
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage([fauxText("work survives stream cancellation")]),
        ]);
        const connection = windows.runtime.remotes.connection(mac.id);
        const started = await nodeRequest<{ output: Array<{ text: string }> }>(
          connection,
          "node.command",
          {
            requestId: "paired-stream-worker",
            command: { action: "run", workspaceId: "work", prompt: "hold while streams close" },
          },
          windows.runtime.remotes.requestNode,
        );
        const session = /Session ID: (\d+)/.exec(started.output[0]!.text)![1]!;
        for (const [operation, input] of [
          ["node.catalog.watch", {}],
          ["node.session.watch", { sessionId: session }],
        ] as const) {
          const controller = new AbortController();
          controllers.push(controller);
          const response = await windows.runtime.remotes.requestNode(connection, operation, input, {
            signal: controller.signal,
          });
          const reader = response.events!.getReader();
          readers.push(reader);
          expect((await reader.read()).done).toBe(false);
        }
        const closed = readers.map(async (reader) => {
          try {
            while (!(await reader.read()).done) {}
          } catch (error) {
            expect(error).toBeInstanceOf(RpcError);
            expect((error as RpcError).code).toBe("OFFLINE");
          }
        });
        if (interruption === "reverse-unpair") {
          const removed = await windows.app.inject({
            method: "POST",
            url: "/api/remotes",
            headers: windows.owner,
            payload: { action: "connection-remove", id: mac.id },
          });
          expect(removed.statusCode, removed.body).toBe(200);
        } else {
          // Losing the socket retires every in-flight native subscription.
          windows.setNodeOnline(false);
          await windows.runtime.remotes.reverse.close();
        }
        await Promise.all(closed);
        await eventually(
          async () => mac.sessionStreams.every((stream) => stream.closed),
          "native session subscription retired",
        );
        await expect(
          windows.runtime.remotes.requestNode(connection, "node.identity", {}),
        ).rejects.toBeInstanceOf(RpcError);
        expect(await mac.runtime.orchestration.listRunning()).toHaveLength(1);
      } finally {
        for (const controller of controllers) controller.abort();
        for (const reader of readers) await reader.cancel().catch(() => {});
        await writeFile(join(mac.work, "release"), "release");
        // Stream cancellation does not stop the worker. Drain its completion and
        // parent delivery before closing storage and deleting the fixture.
        try {
          await eventually(
            async () => (await mac.runtime.orchestration.listRunning()).length === 0,
            "stream fixture worker completion",
          );
          await mac.runtime.main.waitForIdle(context);
        } finally {
          await Promise.all([mac.close(), windows.close()]);
          await rm(directory, { recursive: true, force: true });
        }
      }
    },
    30_000,
  );

  test("native session admission rechecks paired access after asynchronous metadata lookup", async () => {
    const directory = await mkdtemp(join(storageRoot, "batty-paired-rpc-admission-"));
    const windows = await openInstance(directory, "windows");
    const mac = await openInstance(directory, "mac");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let restore: (() => void) | undefined;
    try {
      await connectReverse(windows, mac);
      mac.faux.setResponses([fauxAssistantMessage([fauxText("Native admission evidence")])]);
      const connection = windows.runtime.remotes.connection(mac.id);
      const started = await nodeRequest<{ output: Array<{ text: string }> }>(
        connection,
        "node.command",
        {
          requestId: "rpc-admission-worker",
          command: {
            action: "run",
            workspaceId: "work",
            prompt: "complete before native subscription",
          },
        },
        windows.runtime.remotes.requestNode,
      );
      const session = /Session ID: (\d+)/.exec(started.output[0]!.text)![1]!;
      await eventually(
        async () => (await mac.runtime.orchestration.listRunning()).length === 0,
        "worker completion before paused admission",
      );
      await eventually(
        async () =>
          windows.runtime.remotes
            .list()
            .some(
              (worker) =>
                worker.sessionId === `remote:${mac.id}:${session}` && worker.status === "completed",
            ) &&
          mac.sessionStreams.length > 0 &&
          mac.sessionStreams.every((stream) => stream.closed),
        "background mirror finished its session admission before the controlled request",
      );
      const metadata = mac.runtime.orchestration.metadata.bind(mac.runtime.orchestration);
      const spy = vi
        .spyOn(mac.runtime.orchestration, "metadata")
        .mockImplementation(async (...args) => {
          const result = await metadata(...args);
          if (String(args[0]) === session) {
            entered.resolve();
            await release.promise;
          }
          return result;
        });
      restore = () => spy.mockRestore();
      const pending = windows.runtime.remotes.requestNode(
        connection,
        "node.session.watch",
        { sessionId: session, after: "0" },
        { signal: AbortSignal.timeout(10_000) },
      );
      const rejected = expect(pending).rejects.toMatchObject({ code: "OFFLINE" });
      await entered.promise;
      const removed = await windows.app.inject({
        method: "POST",
        url: "/api/remotes",
        headers: windows.owner,
        payload: { action: "connection-remove", id: mac.id },
      });
      expect(removed.statusCode, removed.body).toBe(200);
      // Creator removal writes an unpair control event, not an acknowledged RPC.
      // Keep metadata paused until the receiving peer has persisted revocation.
      await eventually(
        async () => mac.runtime.remotes.access.getConnection(windows.id) === undefined,
        "receiving peer persisted unpair before session admission resumes",
      );
      release.resolve();
      await rejected;
      await eventually(
        async () => mac.sessionStreams.every((stream) => stream.closed),
        "revoked native session admission cancelled",
      );
    } finally {
      release.resolve();
      restore?.();
      await mac.close();
      await windows.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("reverse pairing rejects impersonation and live grant revocation severs streams without queuing offline commands", async () => {
    const directory = await mkdtemp(join(storageRoot, "batty-reverse-revoke-"));
    let windows: Awaited<ReturnType<typeof openInstance>> | undefined;
    let mac: Awaited<ReturnType<typeof openInstance>> | undefined;
    try {
      windows = await openInstance(directory, "a");
      mac = await openInstance(directory, "b");
      const local = windows;
      const remote = mac;
      await connectReverse(local, remote);
      const identity = remote.runtime.remotes.access.identity().instanceId;
      const dialToken = remote.runtime.remotes.connection(local.id).token;
      const control = (token: string, instance: string) =>
        rejectedSocket(local.url, token, instance);
      expect(await control("wrong-token", identity)).toBe(401);
      expect(await control(dialToken, "untrusted-installation")).toBe(403);

      const otherGrant = await local.runtime.remotes.access.issueInvitation();
      expect(await control(dialToken, "other-installation")).toBe(403);
      expect(await control(otherGrant.token, identity)).toBe(401);
      await eventually(
        async () => local.runtime.remotes.reverse.status(remote.id).state === "connected",
        "legitimate pairing remains connected",
      );

      remote.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("subagent", {
              action: "report",
              prompt: "Auth regression progress",
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
        fauxAssistantMessage([fauxText("auth regression complete")]),
      ]);
      const connection = local.runtime.remotes.connection(remote.id);
      const started = await nodeRequest<{ output: Array<{ text: string }> }>(
        connection,
        "node.command",
        {
          requestId: "auth-regression-run",
          command: { action: "run", workspaceId: "work", prompt: "report progress and hold" },
        },
        local.runtime.remotes.requestNode,
      );
      const session = /Session ID: (\d+)/.exec(started.output[0]!.text)![1]!;
      const id = `remote:${remote.id}:${session}`;
      await eventually(async () => {
        try {
          return (
            (await readFile(join(remote.work, "entered"), "utf8")) === "ready" &&
            JSON.stringify(local.runtime.remotes.messages(id)).includes("Auth regression progress")
          );
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code === "ENOENT" ||
            (error as { statusCode?: number }).statusCode === 404
          )
            return false;
          throw error;
        }
      }, "progress mirrored before revocation");
      const waiting = await nodeRequest<{ details: { assignmentId: string } }>(
        connection,
        "node.command",
        {
          requestId: "auth-regression-await",
          command: { action: "await", sessionId: session },
        },
        local.runtime.remotes.requestNode,
      );
      const revokedAwaitAbort = new AbortController();
      const revokedJoin = local.runtime.remotes.join(
        {
          node: remote.id,
          session,
          assignmentId: waiting.details.assignmentId,
          parentId: local.runtime.main.id,
        },
        revokedAwaitAbort.signal,
      );
      const live = await local.runtime.remotes.requestNode(connection, "node.catalog.watch", {});
      const reader = live.events!.getReader();
      await reader.read();
      const pendingRead = reader.read();
      const interrupted = expect(pendingRead).rejects.toThrow();
      const channel = local.runtime.remotes.reverse.channel(connection);
      let channelClosed = false;
      void channel.closed.then(() => {
        channelClosed = true;
      });
      expect(channelClosed).toBe(false);
      // Internal credential loss must fail closed, independently of owner removal.
      await local.runtime.remotes.access.revoke(connection.localGrantId!);
      local.runtime.remotes.reverse.reconfigure();
      await interrupted;
      try {
        await revokedJoin;
        expect(await transcript(local.runtime)).toMatch(/access removed|revoked/i);
        expect(local.runtime.remotes.access.getConnection(remote.id)).toBeDefined();
      } finally {
        revokedAwaitAbort.abort();
        await revokedJoin.catch(() => {});
      }
      await channel.closed;
      expect(channelClosed).toBe(true);
      expect(await control(dialToken, identity)).toBe(401);
      await eventually(
        async () => local.runtime.remotes.state(id).remote?.connectionState === "offline",
        "retained mirror explicitly offline",
      );
      expect(JSON.stringify(local.runtime.remotes.messages(id))).toContain(
        "Auth regression progress",
      );
      const api = {
        conversationId: local.runtime.main.id,
        taskId: 991,
      } as unknown as Parameters<typeof local.runtime.remotes.command>[1];
      const inspected = await local.runtime.remotes.command(
        { action: "inspect", sessionId: id },
        api,
        context,
      );
      expect(JSON.parse(inspected.output[0]!.text)).toMatchObject({
        sessionId: id,
        status: "running",
        connectionState: "offline",
      });
      const forbiddenStop = local.runtime.remotes.stop(id);
      await expect(forbiddenStop).rejects.toThrow(/access removed|revoked/i);
      await expect(forbiddenStop).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        local.runtime.remotes.command(
          {
            action: "steer",
            sessionId: id,
            prompt: "must not queue offline",
          },
          api,
          context,
        ),
      ).rejects.toThrow(/access removed|revoked/i);
      expect(await remote.runtime.orchestration.listRunning()).toHaveLength(1);
      expect(
        JSON.stringify(await (await remote.runtime.conversation(session)).context(context)),
      ).not.toContain("must not queue offline");
      await reader.cancel().catch(() => {});
    } finally {
      if (mac) await writeFile(join(mac.work, "release"), "release");
      await windows?.close();
      await mac?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("node grants cannot access owner routes, revoke immediately, and reciprocal discovery never exports mirrors", async () => {
    const directory = await mkdtemp(join(storageRoot, "batty-remote-boundary-"));
    let a: Awaited<ReturnType<typeof openInstance>> | undefined;
    let b: Awaited<ReturnType<typeof openInstance>> | undefined;
    try {
      a = await openInstance(directory, "a");
      b = await openInstance(directory, "b");
      const local = a;
      const remote = b;
      await connect(a, b);
      const grant = { token: a.runtime.remotes.connection(b.id).token };
      const listing = await b.app.inject({ url: "/api/remotes", headers: b.owner });
      expect(listing.statusCode).toBe(200);
      expect(listing.json()).toMatchObject({
        ...b.runtime.remotes.access.identity(),
        grants: [],
        connections: [
          {
            id: local.id,
            label: a.runtime.remotes.access.identity().name,
            instanceId: local.id,
            transport: "reverse",
            status: { state: "connected" },
          },
        ],
      });
      expect(listing.body).not.toContain("token");
      expect(listing.body).not.toContain("Hash");
      const auth = { authorization: `Bearer ${grant.token}` };
      expect(await rejectedSocket(b.url, "wrong", a.id)).toBe(401);
      expect(await rejectedSocket(b.url, "", a.id)).toBe(401);
      const identity = await nodeRequest<{ instanceId: string }>(
        a.runtime.remotes.connection(b.id),
        "node.identity",
        {},
        a.runtime.remotes.requestNode,
      );
      expect(identity.instanceId).toBe(b.id);
      // No duplicate HTTP node API survives alongside native operations.
      for (const url of [
        "/api/node/identity",
        "/api/node/workspaces",
        "/api/node/catalog/events",
      ]) {
        expect((await b.app.inject({ url, headers: auth })).statusCode).toBe(404);
      }
      await expect(
        a.runtime.remotes.requestNode(
          a.runtime.remotes.connection(b.id),
          // @ts-expect-error An owner operation must also be rejected at the peer wire boundary.
          "remotes.token.generate",
          {},
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await b.runtime.main.configure(
        { model: { provider: "faux", modelId: "selected-b" } },
        context,
      );
      const nodes = await a.runtime.remotes.workspaces(remote.id);
      expect(nodes).toHaveLength(1);
      expect(nodes[0]).toMatchObject({
        nodeId: remote.id,
        defaultModel: "faux/selected-b",
        workspaces: [expect.objectContaining({ id: "work", isAssistant: true })],
      });
      expect(nodes[0]!.models).toEqual(await b.runtime.listModels());
      expect(nodes[0]!.models).toContainEqual(
        expect.objectContaining({ id: "faux/model-b", thinkingLevels: expect.any(Array) }),
      );
      await b.runtime.main.configure({ model: { provider: "faux", modelId: "model-b" } }, context);
      expect((await b.app.inject({ url: "/api/remotes", headers: auth })).statusCode).toBe(401);
      expect(await rejectedSocket(b.url, "", a.id)).toBe(401);
      b.faux.setResponses([fauxAssistantMessage([fauxText("Remote discovery evidence")])]);
      const started = await nodeRequest<{ output: Array<{ text: string }> }>(
        a.runtime.remotes.connection(b.id),
        "node.command",
        {
          requestId: "discover-start",
          command: { action: "run", workspaceId: "work", prompt: "discovery" },
        },
        a.runtime.remotes.requestNode,
      );
      expect(started.output[0]!.text).toContain("Started");
      await eventually(async () => a!.runtime.remotes.list().length === 1, "A importing B worker");
      const discovery = await nodeRequest<{ output: Array<{ text: string }> }>(
        b.runtime.remotes.connection(a.id),
        "node.command",
        { requestId: "list-from-b", command: { action: "list" } },
        b.runtime.remotes.requestNode,
      );
      const listed = JSON.parse(discovery.output[0]!.text);
      expect(listed.workers).toEqual([]);
      expect(b.runtime.remotes.list()).toEqual([]);
      const selfInvitation = await b.app.inject({
        method: "POST",
        url: "/api/remotes",
        headers: b.owner,
        payload: { action: "token-generate" },
      });
      const self = await b.app.inject({
        method: "POST",
        url: "/api/remotes",
        headers: b.owner,
        payload: {
          action: "connection-add",
          url: b.url,
          token: selfInvitation.json().token,
        },
      });
      expect(self.statusCode).toBe(500);
      expect(self.body).toContain("Pairing failed");
      const revoked = await b.app.inject({
        method: "POST",
        url: "/api/remotes",
        headers: b.owner,
        payload: { action: "token-revoke", id: selfInvitation.json().id },
      });
      expect(revoked.statusCode).toBe(200);
      expect((await b.app.inject({ url: "/api/remotes", headers: b.owner })).json().grants).toEqual(
        [],
      );
      const removed = await a.app.inject({
        method: "POST",
        url: "/api/remotes",
        headers: a.owner,
        payload: { action: "connection-remove", id: remote.id },
      });
      expect(removed.statusCode).toBe(200);
      expect(
        (await a.app.inject({ url: "/api/remotes", headers: a.owner })).json().connections,
      ).toEqual([]);
      expect(a.runtime.remotes.access.getConnection(remote.id)).toBeUndefined();
      await eventually(
        async () => b!.runtime.remotes.access.getConnection(local.id) === undefined,
        "online peer removal notification applied",
      );
      expect(await rejectedSocket(b.url, grant.token, a.id)).toBe(401);
    } finally {
      await Promise.all([a?.close(), b?.close()]);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
}
