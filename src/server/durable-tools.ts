import { hasArtifacts, type NestedCalls, type SessionResources } from "./session-resources";
import type { JsonValue } from "@earendil-works/chord";
import { awaitWithContext } from "@earendil-works/chord/context";
import type { JsonObject } from "@earendil-works/pi-ai";
import type { Extension, TaskId } from "@earendil-works/pi-durable";

export interface DurableToolOptions {
  beforeExecute?: () => Promise<void>;
  recordArtifacts?: (callId: string, details: unknown, taskId: TaskId) => Promise<void>;
  shouldEndTurn?: () => boolean;
}

/** Snapshot model-visible declarations; generation belongs exclusively to the Durable harness. */
export function createDurableToolExtension(
  host: SessionResources,
  options: DurableToolOptions = {},
): Extension {
  return {
    name: "batty-durable-tools",
    tools: host.declaredTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      prepareArguments: tool.prepareArguments,
      replay: "unsafe" as const,
      executionMode: tool.executionMode ?? host.toolExecution,
      async execute(args, api, context) {
        // Checkpoint cancels the waiter even when a hosted tool ignores its signal.
        // Its late completion still runs artifact hooks with the original task identity.
        return awaitWithContext(
          (async () => {
            await options.beforeExecute?.();
            context.abortSignal?.throwIfAborted();
            let previousText = "";
            let latestDetails: JsonValue | undefined;
            let latestNestedCalls: NestedCalls | undefined;
            const commitDetails = async () => {
              if (latestDetails === undefined && latestNestedCalls === undefined) return;
              const details = latestNestedCalls
                ? { ...(latestDetails as JsonObject), nestedCalls: latestNestedCalls }
                : latestDetails!;
              await api.details(details as JsonValue, context);
            };
            const outcome = await host.executeTool(
              { type: "toolCall", id: api.callId, name: tool.name, arguments: args as JsonObject },
              {
                // The Durable harness has already prepared and validated arguments.
                prepared: true,
                signal: context.abortSignal,
                // Capture this invocation's exact task, never resolve it by a reused call ID.
                recordArtifacts: async (_nestedCallId, details) => {
                  await options.recordArtifacts?.(api.callId, details, api.taskId);
                },
                async onNestedUpdate(nestedCalls) {
                  latestNestedCalls = nestedCalls;
                  if (context.abortSignal?.aborted) return;
                  try {
                    await commitDetails();
                  } catch (error) {
                    if (!context.abortSignal?.aborted) throw error;
                  }
                },
                async onUpdate(update) {
                  if (context.abortSignal?.aborted) return;
                  const text = update.content
                    .filter((block) => block.type === "text")
                    .map((block) => block.text)
                    .join("\n");
                  // Tool updates are snapshots, whereas durable output is append-only.
                  // Append just growth, or a new line containing a rewritten snapshot.
                  const chunk = text.startsWith(previousText)
                    ? text.slice(previousText.length)
                    : `${previousText ? "\n" : ""}${text}`;
                  try {
                    if (chunk) api.output(chunk);
                    previousText = text;
                    if (update.details !== undefined) latestDetails = update.details as JsonValue;
                    await commitDetails();
                  } catch (error) {
                    // Cancellation may race a details commit. Progress must not make
                    // execution lose its final result or skip artifact hooks.
                    if (!context.abortSignal?.aborted) throw error;
                  }
                },
              },
            );
            const { result, isError } = outcome;
            if (hasArtifacts(result.details)) {
              // A cancelled durable tool task may discard its late return value. Save
              // completed side effects through the controller's independent commit.
              await options.recordArtifacts?.(api.callId, result.details, api.taskId);
            }
            const nestedCalls = outcome.nestedCalls;
            return {
              content: result.content,
              details: (nestedCalls
                ? { ...(result.details as Record<string, JsonValue>), nestedCalls }
                : result.details) as JsonValue,
              isError,
              usage: result.usage,
              ...(result.terminate || options.shouldEndTurn?.()
                ? { control: { terminate: true as const } }
                : {}),
            };
          })(),
          context,
        );
      },
    })),
  };
}
