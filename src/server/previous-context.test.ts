import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { BATTY_SYSTEM_PROMPT_CUSTOM_TYPE } from "./batty-system-prompt";
import { createHarnessFixture } from "./harness-test-fixture";
import { createSessionManagerWithPreviousContext } from "./previous-context";

async function closeManager(
  manager: Awaited<ReturnType<typeof createSessionManagerWithPreviousContext>>["manager"],
) {
  manager.release();
  await manager.native.close(context);
}

describe("createSessionManagerWithPreviousContext", () => {
  it("keeps native cache lineage for full copies and projects chat-only copies", async () => {
    const parent = await createHarnessFixture();
    await parent.session.sessionManager.appendCustomEntry(BATTY_SYSTEM_PROMPT_CUSTOM_TYPE, {
      appendedPrompt: "cached system prompt",
    });
    await parent.session.lane.appendMessage(
      { role: "user", content: "Question", timestamp: 1 },
      context,
    );
    await parent.session.lane.appendMessage(
      fauxAssistantMessage([
        { type: "thinking", thinking: "Reasoning" },
        { type: "text", text: "Answer" },
        { type: "toolCall", id: "read-1", name: "read", arguments: { path: "x" } },
      ]),
      context,
    );
    await parent.session.lane.appendMessage(
      {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        content: [{ type: "text", text: "Output" }],
        isError: false,
        timestamp: 2,
      },
      context,
    );
    const leafId = parent.session.sessionManager.getLeafId();

    const full = await createSessionManagerWithPreviousContext({
      cwd: parent.root,
      targetRoot: path.join(parent.root, "full"),
      sourceSessionPath: parent.session.sessionFile,
      leafId,
      mode: true,
    });
    const chatOnly = await createSessionManagerWithPreviousContext({
      cwd: parent.root,
      targetRoot: path.join(parent.root, "chat-only"),
      parentSessionId: parent.session.sessionId,
      sourceSessionPath: parent.session.sessionFile,
      leafId,
      mode: "chat-only",
    });

    expect(full.manager.native.metadata.parentSessionId).toBe(parent.session.sessionId);
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

    await closeManager(full.manager);
    await closeManager(chatOnly.manager);
    await parent.cleanup();
  });
});
