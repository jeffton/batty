import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { BATTY_SYSTEM_PROMPT_CUSTOM_TYPE } from "./batty-system-prompt";
import { SessionStore } from "./session-store";
import lockfile from "proper-lockfile";
import { createSessionManagerWithPreviousContext } from "./previous-context";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("createSessionManagerWithPreviousContext", () => {
  it("closes historical full-copy writers and keeps chat-only copies passive", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-scoped-context-"));
    roots.push(root);
    const parent = await SessionStore.create(root, path.join(root, "parent"));
    const leafId = await parent.appendMessage({ role: "user", content: "shared", timestamp: 1 });
    const sourceSessionPath = parent.getSessionFile();
    await parent.close();
    const full = await createSessionManagerWithPreviousContext({
      cwd: root,
      sourceSessionPath,
      leafId,
      targetRoot: path.join(root, "full"),
      mode: true,
    });
    try {
      expect(await lockfile.check(sourceSessionPath)).toBe(false);
      expect(full.manager.getEntries()[0]).toMatchObject({ message: { content: "shared" } });
      const chat = await createSessionManagerWithPreviousContext({
        cwd: root,
        sourceSessionPath,
        leafId,
        targetRoot: path.join(root, "chat"),
        mode: "chat-only",
      });
      try {
        expect(chat.chatOnlyMessages).toEqual([
          expect.objectContaining({ role: "user", content: "shared" }),
        ]);
        expect(await lockfile.check(sourceSessionPath)).toBe(false);
      } finally {
        await chat.manager.close();
      }
      await expect(
        createSessionManagerWithPreviousContext({
          cwd: root,
          sourceSessionPath,
          leafId: "missing",
          targetRoot: path.join(root, "failed"),
          mode: true,
        }),
      ).rejects.toThrow("Unknown session entry");
      expect(await lockfile.check(sourceSessionPath)).toBe(false);
    } finally {
      await full.manager.close();
    }
  });
  it("uses the captured leaf even when the source has moved to a later leaf", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-captured-context-"));
    roots.push(root);
    const parent = await SessionStore.create(root, path.join(root, "parent"));
    const firstId = await parent.appendMessage({ role: "user", content: "shared", timestamp: 1 });
    const capturedId = await parent.appendMessage({
      role: "user",
      content: "captured",
      timestamp: 2,
    });
    await parent.appendMessage({ role: "user", content: "other branch", timestamp: 3 });
    const options = { cwd: root, sourceSessionPath: parent.getSessionFile(), leafId: capturedId };
    const full = await createSessionManagerWithPreviousContext({
      ...options,
      targetRoot: path.join(root, "full"),
      mode: true,
    });
    const chatOnly = await createSessionManagerWithPreviousContext({
      ...options,
      targetRoot: path.join(root, "chat"),
      mode: "chat-only",
    });
    expect(full.manager.getEntries().map((entry) => entry.id)).toEqual([firstId, capturedId]);
    expect(chatOnly.chatOnlyMessages?.map((message) => message.content)).toEqual([
      "shared",
      "captured",
    ]);
    await full.manager.release();
    await chatOnly.manager.release();
    await parent.release();
  });

  it("preserves durable full history and projects chat-only copies", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-previous-context-"));
    roots.push(root);
    const parent = await SessionStore.create(root, path.join(root, "parent"));
    await parent.appendCustomEntry(BATTY_SYSTEM_PROMPT_CUSTOM_TYPE, {
      appendedPrompt: "cached system prompt",
    });
    await parent.appendMessage({ role: "user", content: "Question", timestamp: 1 });
    await parent.appendMessage(
      fauxAssistantMessage([
        { type: "thinking", thinking: "Reasoning" },
        { type: "text", text: "Answer" },
        { type: "toolCall", id: "read-1", name: "read", arguments: { path: "x" } },
      ]),
    );
    await parent.appendMessage({
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read",
      content: [{ type: "text", text: "Output" }],
      isError: false,
      timestamp: 2,
    });
    const options = {
      cwd: root,
      sourceSessionPath: parent.getSessionFile(),
      leafId: parent.getLeafId(),
    };
    const full = await createSessionManagerWithPreviousContext({
      ...options,
      targetRoot: path.join(root, "full"),
      mode: true,
    });
    const chatOnly = await createSessionManagerWithPreviousContext({
      ...options,
      targetRoot: path.join(root, "chat-only"),
      parentSessionId: parent.getSessionId(),
      mode: "chat-only",
    });
    expect(full.manager.getHeader()?.parentSession).toBe(
      await fs.realpath(parent.getSessionFile()),
    );
    expect(full.manager.getEntries()).toContainEqual(
      expect.objectContaining({
        customType: BATTY_SYSTEM_PROMPT_CUSTOM_TYPE,
        data: { appendedPrompt: "cached system prompt" },
      }),
    );
    expect(chatOnly.manager.getEntries()).toEqual([]);
    expect(chatOnly.chatOnlyMessages).toEqual([
      expect.objectContaining({ role: "user", content: "Question" }),
      expect.objectContaining({
        role: "assistant",
        content: [expect.objectContaining({ type: "text", text: "Answer" })],
      }),
    ]);
    await full.manager.release();
    await chatOnly.manager.release();
    await parent.release();
  });
});
