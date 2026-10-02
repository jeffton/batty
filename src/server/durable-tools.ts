import { runToolCall } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@earendil-works/chord";
import type { JsonObject } from "@earendil-works/pi-ai";
import type { Extension, TaskId } from "@earendil-works/pi-durable";

export interface DurableToolOptions {
  beforeExecute?: () => Promise<void>;
  recordArtifacts?: (callId: string, details: unknown, taskId: TaskId) => Promise<void>;
  shouldEndTurn?: () => boolean;
}

/** Snapshot the SDK's active executable tools; generation belongs to the durable harness. */
export function createDurableToolExtension(
  sdk: AgentSession,
  options: DurableToolOptions = {},
): Extension {
  return {
    name: "batty-sdk-tools",
    tools: sdk.agent.state.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      prepareArguments: tool.prepareArguments,
      replay: "unsafe" as const,
      executionMode: sdk.agent.toolExecution,
      async execute(args, api, context) {
        await options.beforeExecute?.();
        // The controller synchronizes the durable transcript into SDK state. Nested
        // codemode calls also use that state to find their issuing assistant.
        const state = sdk.agent.state;
        const assistantMessage = state.messages.findLast((message) => message.role === "assistant");
        if (!assistantMessage) throw new Error("No assistant message issued this tool call");
        let previousText = "";
        const outcome = await runToolCall(
          { type: "toolCall", id: api.callId, name: tool.name, arguments: args as JsonObject },
          {
            // The durable harness has already prepared and validated arguments.
            tools: [{ ...tool, prepareArguments: undefined }],
            assistantMessage,
            context: { messages: state.messages, tools: state.tools },
            beforeToolCall: sdk.agent.beforeToolCall,
            afterToolCall: sdk.agent.afterToolCall,
            signal: context.abortSignal,
            async onUpdate(update) {
              if (context.abortSignal?.aborted) return;
              const text = update.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("\n");
              // SDK updates are snapshots, whereas durable output is append-only.
              // Append just growth, or a new line containing a rewritten snapshot.
              const chunk = text.startsWith(previousText)
                ? text.slice(previousText.length)
                : `${previousText ? "\n" : ""}${text}`;
              try {
                if (chunk) api.output(chunk);
                previousText = text;
                if (update.details !== undefined)
                  await api.details(update.details as JsonValue, context);
              } catch (error) {
                // Cancellation may race a details commit. Progress must not make
                // SDK execution lose its final result or skip artifact hooks.
                if (!context.abortSignal?.aborted) throw error;
              }
            },
          },
        );
        const { result, isError } = outcome;
        if (
          result.details &&
          typeof result.details === "object" &&
          ["battyFileChanges", "sentFiles", "sites"].some((key) => key in result.details)
        ) {
          // A cancelled durable tool task may discard its late return value. Save
          // completed side effects through the controller's independent commit.
          await options.recordArtifacts?.(api.callId, result.details, api.taskId);
        }
        return {
          content: result.content,
          details: result.details as JsonValue,
          isError,
          usage: result.usage,
          ...(result.terminate || options.shouldEndTurn?.()
            ? { control: { terminate: true as const } }
            : {}),
        };
      },
    })),
  };
}
