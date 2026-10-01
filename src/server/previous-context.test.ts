import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { BATTY_SYSTEM_PROMPT_CUSTOM_TYPE } from "./batty-system-prompt";
import { SessionStore } from "./session-store";
import { createSessionManagerWithPreviousContext } from "./previous-context";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("createSessionManagerWithPreviousContext", () => {
  it("uses the captured leaf even when the source has moved to another branch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-captured-context-"));
    roots.push(root);
    const parent = await SessionStore.create(root, path.join(root, "parent"));
    const firstId = await parent.appendMessage({ role: "user", content: "shared", timestamp: 1 });
    const capturedId = await parent.appendMessage({
      role: "user",
      content: "captured",
      timestamp: 2,
    });
    parent.native.branch(firstId);
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
    full.manager.release();
    chatOnly.manager.release();
    parent.release();
  });

  it("preserves native full history and projects chat-only copies", async () => {
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
    expect(full.manager.native.getHeader()?.parentSession).toBe(
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
    full.manager.release();
    chatOnly.manager.release();
    parent.release();
  });
});
