// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { RemoteWorkers } from "./remote-workers";
import type { Runtime } from "./runtime";

test("Tasks require a durable local assignment, not peer discovery or matching session/workspace IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "batty-remote-task-ownership-"));
  const directory = join(root, ".batty", "remote-mirrors");
  await mkdir(directory, { recursive: true });
  const runtime = { config: { battyDir: root }, main: { id: 1 } } as unknown as Runtime;
  let remotes: RemoteWorkers | undefined;
  try {
    const assignments = [
      { node: "windows", requestId: "main-run", parentId: 1, session: "20", prompt: "main child" },
      {
        node: "windows",
        requestId: "nested-run",
        parentId: 2,
        session: "21",
        prompt: "nested child",
      },
      { node: "windows", requestId: "cron-run", parentId: 3, session: "22", prompt: "cron child" },
      // The session is not known until the command response arrives.
      { node: "windows", requestId: "in-flight", parentId: 1, prompt: "pending" },
      { node: "mac", requestId: "other-peer", parentId: 1, session: "23", prompt: "other peer" },
      { node: "windows", requestId: "done", parentId: 1, session: "24", prompt: "completed" },
    ];
    await writeFile(
      join(directory, "assignments.json"),
      JSON.stringify({ assignments, origins: {} }),
    );
    for (const [node, session, status] of [
      ["windows", "1", "running"], // Peer-local ID collides with our main conversation.
      ["windows", "20", "running"],
      ["windows", "21", "running"],
      ["windows", "22", "running"],
      ["windows", "23", "running"], // Same session ID, wrong node.
      ["windows", "24", "completed"],
      ["windows", "25", "running"], // Discovery while a command is still in flight.
      ["mac", "23", "running"],
    ]) {
      await writeFile(
        join(directory, `${node}-${session}.json`),
        JSON.stringify({
          node,
          session,
          summary: { sessionId: session, workspaceId: "work", status },
          messages: [],
        }),
      );
    }
    remotes = await RemoteWorkers.open(runtime);
    for (const node of ["windows", "mac"]) {
      await remotes.access.addConnection({
        id: node,
        label: node,
        url: `https://${node}.example/`,
        token: "fixture",
      });
    }
    for (let restart = 0; restart < 2; restart++) {
      expect(remotes.list()).toHaveLength(8); // Discovery remains deliberately broader than Tasks.
      expect(
        remotes
          .tasks(1)
          .map((task) => task.sessionId)
          .sort(),
      ).toEqual(["remote:mac:23", "remote:windows:20"]);
      expect(remotes.tasks(2).map((task) => task.sessionId)).toEqual(["remote:windows:21"]);
      expect(remotes.tasks(3).map((task) => task.sessionId)).toEqual(["remote:windows:22"]);
      expect(remotes.tasks(4)).toEqual([]);
      await remotes.close();
      remotes = await RemoteWorkers.open(runtime);
    }
  } finally {
    await remotes?.close();
    await rm(root, { recursive: true, force: true });
  }
});
