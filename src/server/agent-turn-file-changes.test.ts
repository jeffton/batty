import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  AGENT_TURN_FILE_CHANGES_CUSTOM_TYPE,
  AgentTurnFileChangeTracker,
  agentTurnFileChangesByReplyEntryId,
} from "./agent-turn-file-changes";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "batty-turn-diff-")));
  temporaryDirectories.push(directory);
  return directory;
}

function loadExtension(tracker: AgentTurnFileChangeTracker, cwd: string) {
  const tools = new Map<string, ToolDefinition<any>>();
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const appendEntry = vi.fn();

  const extension = tracker.createExtension(cwd) as unknown as {
    factory: (pi: ExtensionAPI) => void;
  };
  extension.factory({
    registerTool(tool: ToolDefinition<any>) {
      tools.set(tool.name, tool);
    },
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
    },
    appendEntry,
  } as never);

  return { tools, handlers, appendEntry };
}

function completedRunContext(replyEntryId: string) {
  return {
    sessionManager: {
      getBranch: () => [{ type: "message", id: replyEntryId, message: { role: "assistant" } }],
    },
  };
}

async function start(extension: ReturnType<typeof loadExtension>): Promise<void> {
  await extension.handlers.get("agent_start")!({}, {});
}

async function completeRun(
  extension: ReturnType<typeof loadExtension>,
  replyEntryId: string,
): Promise<void> {
  await extension.handlers.get("agent_end")!({}, completedRunContext(replyEntryId));
}

async function writeFile(
  extension: ReturnType<typeof loadExtension>,
  filePath: string,
  content: string,
): Promise<void> {
  await extension.tools
    .get("write")!
    .execute("write-call", { path: filePath, content }, undefined, undefined, {} as never);
}

describe("AgentTurnFileChangeTracker", () => {
  it("captures files outside the session workspace and collapses repeated writes", async () => {
    const workspace = await makeTemporaryDirectory();
    const otherWorkspace = await makeTemporaryDirectory();
    const filePath = path.join(otherWorkspace, "src", "value.ts");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "export const value = 1;\n");

    const extension = loadExtension(new AgentTurnFileChangeTracker(), workspace);
    await start(extension);
    await writeFile(extension, filePath, "export const value = 2;\n");
    await writeFile(extension, filePath, "export const value = 3;\n");
    await completeRun(extension, "reply-main");

    expect(extension.appendEntry).toHaveBeenCalledWith(
      AGENT_TURN_FILE_CHANGES_CUSTOM_TYPE,
      expect.objectContaining({
        version: 1,
        replyEntryId: "reply-main",
        files: [
          {
            path: filePath,
            patch: expect.stringContaining("-export const value = 1;\n+export const value = 3;"),
          },
        ],
      }),
    );
  });

  it("associates consecutive runs with their own assistant replies", async () => {
    const workspace = await makeTemporaryDirectory();
    const filePath = path.join(workspace, "value.ts");
    const extension = loadExtension(new AgentTurnFileChangeTracker(), workspace);

    await start(extension);
    await writeFile(extension, filePath, "first\n");
    await completeRun(extension, "reply-first");
    await start(extension);
    await writeFile(extension, filePath, "second\n");
    await completeRun(extension, "reply-second");

    expect(extension.appendEntry.mock.calls.map((call) => call[1])).toMatchObject([
      {
        replyEntryId: "reply-first",
        files: [{ path: filePath, patch: expect.stringContaining("+first") }],
      },
      {
        replyEntryId: "reply-second",
        files: [{ path: filePath, patch: expect.stringContaining("-first\n+second") }],
      },
    ]);
  });

  it("includes child writes in the parent while keeping the child entry filtered", async () => {
    const workspace = await makeTemporaryDirectory();
    const parentFile = path.join(workspace, "parent.ts");
    const childFile = path.join(workspace, "child.ts");
    const parentTracker = new AgentTurnFileChangeTracker();
    const parent = loadExtension(parentTracker, workspace);
    await start(parent);
    const child = loadExtension(
      new AgentTurnFileChangeTracker(parentTracker.aggregateForChild()),
      workspace,
    );
    await start(child);

    await writeFile(parent, parentFile, "parent\n");
    await writeFile(child, childFile, "child\n");
    await completeRun(child, "reply-child");
    await completeRun(parent, "reply-main");

    expect(child.appendEntry.mock.calls[0]?.[1]).toMatchObject({
      replyEntryId: "reply-child",
      files: [{ path: childFile, patch: expect.stringContaining("+child") }],
    });
    expect(parent.appendEntry.mock.calls[0]?.[1]).toMatchObject({
      replyEntryId: "reply-main",
      files: [
        { path: childFile, patch: expect.stringContaining("+child") },
        { path: parentFile, patch: expect.stringContaining("+parent") },
      ],
    });
  });
});

describe("agentTurnFileChangesByReplyEntryId", () => {
  it("returns valid entries and ignores malformed entries", () => {
    const result = agentTurnFileChangesByReplyEntryId([
      {
        type: "custom",
        customType: AGENT_TURN_FILE_CHANGES_CUSTOM_TYPE,
        data: {
          version: 1,
          replyEntryId: "reply-1",
          files: [{ path: "/repo/a.ts", patch: "patch" }],
        },
      },
      {
        type: "custom",
        customType: AGENT_TURN_FILE_CHANGES_CUSTOM_TYPE,
        data: { version: 2, replyEntryId: "reply-2", files: [] },
      },
    ]);

    expect(result).toEqual(new Map([["reply-1", [{ path: "/repo/a.ts", patch: "patch" }]]]));
  });
});
