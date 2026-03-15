import { describe, expect, it } from "vite-plus/test";
import { withoutRenderedToolCalls } from "@/client/lib/active-assistant";
import type { UiMessage } from "@/shared/types";

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

describe("withoutRenderedToolCalls", () => {
  it("hides tool call blocks that are already rendered in the transcript", () => {
    const assistant = createAssistant([
      { type: "text", text: "Working on it" },
      {
        type: "toolCall",
        id: "call-1",
        name: "bash",
        arguments: { command: "./scripts/reload-self.sh", timeout: 1800 },
      },
    ]);

    expect(withoutRenderedToolCalls(assistant, new Set(["call-1"]))).toEqual(
      createAssistant([{ type: "text", text: "Working on it" }]),
    );
  });

  it("returns undefined when the assistant only contains duplicated tool calls", () => {
    const assistant = createAssistant([
      {
        type: "toolCall",
        id: "call-1",
        name: "bash",
        arguments: { command: "./scripts/reload-self.sh", timeout: 1800 },
      },
    ]);

    expect(withoutRenderedToolCalls(assistant, new Set(["call-1"]))).toBeUndefined();
  });
});
