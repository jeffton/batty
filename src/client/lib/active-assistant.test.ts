import { describe, expect, it } from "vite-plus/test";
import { withoutActiveToolCalls } from "@/client/lib/active-assistant";
import type { ActiveToolRun, UiMessage } from "@/shared/types";

function createAssistant(
  blocks: Extract<UiMessage, { role: "assistant" }>["blocks"],
): Extract<UiMessage, { role: "assistant" }> {
  return {
    id: "assistant-1",
    role: "assistant",
    timestamp: 1,
    blocks,
  };
}

const activeBashTool: ActiveToolRun = {
  toolCallId: "call-1",
  toolName: "bash",
  args: { command: "./scripts/reload-self.sh", timeout: 1800 },
  blocks: [],
  isError: false,
};

describe("withoutActiveToolCalls", () => {
  it("hides active tool call blocks that are already shown in the running tool card", () => {
    const assistant = createAssistant([
      { type: "text", text: "Working on it" },
      {
        type: "toolCall",
        id: "call-1",
        name: "bash",
        arguments: { command: "./scripts/reload-self.sh", timeout: 1800 },
      },
    ]);

    expect(withoutActiveToolCalls(assistant, [activeBashTool])).toEqual(
      createAssistant([{ type: "text", text: "Working on it" }]),
    );
  });

  it("returns undefined when the assistant only contains duplicated active tool calls", () => {
    const assistant = createAssistant([
      {
        type: "toolCall",
        id: "call-1",
        name: "bash",
        arguments: { command: "./scripts/reload-self.sh", timeout: 1800 },
      },
    ]);

    expect(withoutActiveToolCalls(assistant, [activeBashTool])).toBeUndefined();
  });
});
