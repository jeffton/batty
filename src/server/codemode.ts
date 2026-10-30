import { withAbortSignal } from "@earendil-works/chord/context";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
  CodemodeSandbox,
  CODEMODE_SOURCE_GRAMMAR,
  parseCodemodeSource,
  renderDeclarations,
  type CodemodeTool,
  type CodemodeJsonSchema,
} from "@earendil-works/pi-codemode";
import {
  defineDoc,
  defineTool,
  NestedCallDoc,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import type { McpService } from "./mcp-service";
import type { CodemodeCall } from "../shared/types";
import { MAIN_MEMORY_TOOLS } from "./main-memory-policy";
import { codemodeAdapterName, type CodemodeResult } from "./codemode-native";
import { isPiShellToolName } from "../shared/pi-tools";
import { WebSearchOutputSchema } from "./tool-schemas";

export const CodemodeCalls = defineDoc<{
  calls: Record<string, { taskId: number; name: string; args: JsonValue }>;
}>({
  kind: "batty.codemode-calls",
  version: 1,
  scope: "task",
  checkpointWhen: () => false,
  initial: () => ({ calls: {} }),
});

export const CodemodeStore = defineDoc<{ values: Record<string, JsonValue> }>({
  kind: "batty.codemode-store",
  checkpointWhen: () => false,
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ values: {} }),
});

export function createCodemodeTool(
  resolveTools: (api: ToolExecutionApi, ctx: Context) => Promise<ToolRegistration[]>,
  mcp: McpService,
  sandboxes: Set<CodemodeSandbox>,
  abortNested: (id: import("@earendil-works/pi-durable").TaskId, ctx: Context) => Promise<void>,
) {
  return defineTool({
    name: "codemode",
    description:
      'Run JavaScript in a QuickJS sandbox. Use await tools.<name>(args), text(value), image(block), return, store/load, ALL_TOOLS, searchTools(query), describeTool(name), and describeNamespace(name). No Node, network, filesystem, or timers. Optional first line: // @options: {"max_output_tokens": 10000, "timeout_ms": 60000}.',
    parameters: Type.Object({ code: Type.String() }),
    executionMode: "sequential",
    replay: "safe",
    constrainedSampling: { type: "grammar", variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } },
    execute: async ({ code }, api, ctx) => {
      const parsed = parseCodemodeSource(code);
      const registrations = (await resolveTools(api, ctx)).filter(
        (tool) => tool.name !== "codemode",
      );
      const calls: CodemodeCall[] = [];
      const ordinaryOutputs = new Set<string>();
      const forwardedImages: ImageContent[] = [];
      const ordinaryImages = new Set<ImageContent>();
      let usedMainMemory = false;
      let ordinal = 0;
      const activeCalls = new Set<Promise<unknown>>();
      const aborts: Promise<void>[] = [];
      const abortErrors: unknown[] = [];
      let control: import("@earendil-works/pi-durable").ToolControl | undefined;
      const tools: CodemodeTool[] = registrations.map((tool) => ({
        name: tool.name,
        description:
          tool.name === "read"
            ? `${tool.description} In codemode, read returns text only; image reads return a text note and automatically forward the image to the model. Do not wrap read in image().`
            : tool.description,
        inputSchema: tool.parameters as unknown as CodemodeJsonSchema,
        outputSchema: isPiShellToolName(tool.name)
          ? {
              type: "object",
              properties: {
                output: { type: "string" },
                exit_code: { type: "number" },
                truncated: { type: "boolean" },
                wall_time_seconds: { type: "number" },
                full_output_path: { type: "string" },
              },
              required: ["output", "exit_code", "truncated", "wall_time_seconds"],
            }
          : tool.name.startsWith("mcp__")
            ? {
                type: "object",
                properties: {
                  content: { type: "array", items: {} },
                  structuredContent: {},
                  isError: { type: "boolean" },
                },
              }
            : tool.name === "web_search"
              ? (WebSearchOutputSchema as unknown as CodemodeJsonSchema)
              : { type: "string" },
        execute: (input, { signal }) => {
          const pending = executeNested(input, signal);
          activeCalls.add(pending);
          return pending.finally(() => activeCalls.delete(pending));

          async function executeNested(input: unknown, signal: AbortSignal) {
            signal.throwIfAborted();
            // Inputs fixed before memory was read cannot be derived from that read.
            const independentOfMainMemory = !usedMainMemory;
            const index = String(ordinal++);
            const started = performance.now();
            const call: CodemodeCall = {
              id: `${api.callId}-${index}`,
              name: tool.name,
              args: input === undefined ? "undefined" : JSON.stringify(input),
              status: "running",
            };
            calls.push(call);
            try {
              const args = tool.prepareArguments ? tool.prepareArguments(input) : input;
              call.args = args === undefined ? "undefined" : JSON.stringify(args);
              const validator = Compile(tool.parameters);
              if (!validator.Check(args))
                throw new Error(
                  `Invalid arguments for ${tool.name}: ${JSON.stringify([...validator.Errors(args)])}`,
                );
              // Existing callers must consume their legacy receipts, never repeat side effects.
              const legacy = (await api.snapshot(CodemodeCalls, api.taskId, ctx))?.calls[index];
              signal.throwIfAborted();
              let value: CodemodeResult;
              if (legacy) {
                if (
                  legacy.name !== tool.name ||
                  JSON.stringify(legacy.args) !== JSON.stringify(args)
                )
                  throw new Error(`Codemode replay changed nested call ${index}`);
                const taskId =
                  legacy.taskId as import("@earendil-works/pi-durable").TaskId<CodemodeResult>;
                const abort = () => {
                  // Harness shutdown must preserve resumable tasks. Explicit harness
                  // aborts already cascade through ownership; only sandbox-local
                  // deadlines/unawaited calls need an additional task abort.
                  if (ctx.abortSignal?.aborted) return;
                  aborts.push(
                    abortNested(taskId, ctx).catch((error) => {
                      abortErrors.push(error);
                    }),
                  );
                };
                signal.addEventListener("abort", abort, { once: true });
                let settled;
                try {
                  settled = await api.waitForTask(taskId, withAbortSignal(signal, ctx));
                } finally {
                  signal.removeEventListener("abort", abort);
                }
                const outcome = settled.state.outcome;
                if (outcome.status !== "completed") {
                  if (outcome.status === "aborted") call.status = "cancelled";
                  throw new Error(
                    outcome.status === "faulted"
                      ? outcome.error.message
                      : outcome.status === "orphaned"
                        ? outcome.reason
                        : `Nested tool ${tool.name} ${outcome.status}`,
                  );
                }
                if ("released" in outcome.result)
                  throw new Error(`Legacy codemode result ${taskId} has been released`);
                value = outcome.result;
              } else {
                const key = `codemode-${index}`;
                let nested;
                try {
                  nested = await api.executeTool(
                    codemodeAdapterName(tool.replay ?? "unsafe"),
                    { name: tool.name, args: args as JsonValue },
                    withAbortSignal(signal, ctx),
                    { key, progress: false },
                  );
                } finally {
                  // A local sandbox abort cancels the native wait, not its child task.
                  // Admission has settled before executeTool rejects, so its slot is discoverable.
                  if (signal.aborted && !ctx.abortSignal?.aborted) {
                    const cancel = (async () => {
                      const slot = await api.snapshot(NestedCallDoc, api.taskId, key, ctx);
                      if (slot?.taskId) await abortNested(slot.taskId, ctx);
                    })().catch((error) => {
                      abortErrors.push(error);
                    });
                    aborts.push(cancel);
                    await cancel;
                  }
                }
                if (nested.isError || nested.structuredOutput === undefined)
                  throw new Error(
                    nested.diagnostics
                      .map((item) =>
                        item.message.replaceAll(
                          codemodeAdapterName(tool.replay ?? "unsafe"),
                          tool.name,
                        ),
                      )
                      .join("\n") || `Nested tool ${tool.name} failed`,
                  );
                value = nested.structuredOutput as unknown as CodemodeResult;
              }
              const { result, structured } = value;
              call.details = result.details ?? null;
              if (
                result.details &&
                typeof result.details === "object" &&
                !Array.isArray(result.details)
              ) {
                Object.assign(call, result.details, {
                  id: call.id,
                  name: call.name,
                  args: call.args,
                  status: call.status,
                });
              }
              if (result.control) control = result.control;
              const text =
                result.output
                  ?.filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("\n") ?? "";
              if (MAIN_MEMORY_TOOLS.has(tool.name)) usedMainMemory = true;
              else if (independentOfMainMemory) ordinaryOutputs.add(text);
              const images = (result.output ?? []).filter((block) => block.type === "image");
              if ((tool.name === "read" || tool.name === "memory_zoom") && !result.isError) {
                forwardedImages.push(...images);
                if (tool.name === "read" && independentOfMainMemory)
                  for (const image of images) ordinaryImages.add(image);
              }
              if (result.isError && result.structuredOutput === undefined) throw new Error(text);
              call.status = result.isError ? "error" : "ok";
              // Image bytes stay out of the script bridge and its text/return serialization.
              if (tool.name === "read" && images.length > 0) return text;
              if (result.structuredOutput !== undefined) return result.structuredOutput;
              if (structured !== null) return structured;
              return text;
            } catch (error) {
              if (signal.aborted) call.status = "cancelled";
              else if (call.status !== "cancelled") call.status = "error";
              call.error = error instanceof Error ? error.message : String(error);
              throw error;
            } finally {
              call.durationMs = performance.now() - started;
            }
          }
        },
      }));
      const globals: CodemodeTool[] = [
        {
          name: "searchTools",
          spread: true,
          execute: (args) => {
            const [query, options = {}] = args as [string, { limit?: number; namespace?: string }];
            const words = query.toLowerCase().split(/\s+/);
            return tools
              .filter(
                (tool) =>
                  (!options.namespace || tool.name.startsWith(options.namespace)) &&
                  words.every((word) =>
                    `${tool.name} ${tool.description}`.toLowerCase().includes(word),
                  ),
              )
              .slice(0, options.limit ?? 20)
              .map((tool) => ({ name: tool.name, description: tool.description }));
          },
        },
        {
          name: "describeTool",
          execute: (name) => {
            const tool = tools.find((tool) => tool.name === name);
            if (!tool) throw new Error(`Unknown tool: ${name}`);
            return renderDeclarations({ tools: [tool] });
          },
        },
        {
          name: "describeNamespace",
          execute: (name) =>
            renderDeclarations({
              tools: tools.filter((tool) => tool.name.startsWith(String(name))),
            }),
        },
      ];
      let workerExited: Promise<void> | undefined;
      const sandbox = new CodemodeSandbox({
        tools,
        globals,
        onWorkerStarted: (exited) => {
          workerExited = exited;
        },
        timeoutMs: 300_000,
        memoryLimitBytes: 256 * 1024 * 1024,
      });
      sandboxes.add(sandbox);
      try {
        const currentStore = await api.snapshot(CodemodeStore, api.conversationId, ctx);
        const saved = await api.memo(
          "batty.codemode.initial-store",
          currentStore?.values ?? {},
          ctx,
        );
        const result = await sandbox.execute(parsed.code, {
          signal: ctx.abortSignal,
          timeoutMs: parsed.options.timeoutMs,
          store: saved,
        });
        if (result.ok)
          await api.commit(async (tx) => {
            const state = await tx.doc(CodemodeStore, api.conversationId);
            for (const key of result.storeWrites.delete) delete state.values[key];
            Object.assign(state.values, result.storeWrites.set);
          }, ctx);
        const content = [...result.output, ...forwardedImages];
        if (result.ok && result.value !== undefined)
          content.push({
            type: "text",
            text: typeof result.value === "string" ? result.value : JSON.stringify(result.value),
          });
        if (!result.ok)
          content.push({ type: "text", text: result.error.stack ?? result.error.message });
        let budget = (parsed.options.maxOutputTokens ?? 10000) * 4;
        const safeBlocks = content.map((block) =>
          block.type === "text" ? ordinaryOutputs.has(block.text) : ordinaryImages.has(block),
        );
        const limited = content.map((block) => {
          if (block.type !== "text") return block;
          const text = block.text.slice(0, Math.max(0, budget));
          budget -= block.text.length;
          return { ...block, text };
        });
        const effects = (key: string) =>
          calls.flatMap((call) => (Array.isArray(call[key]) ? (call[key] as JsonValue[]) : []));
        const sentFiles = effects("sentFiles");
        const sites = effects("sites");
        const battyFileChanges = effects("battyFileChanges");
        const fileChanges = effects("fileChanges");
        const forwarded = calls.flatMap((call) =>
          call.forwardedArtifacts
            ? [
                call.forwardedArtifacts as {
                  fileChanges?: JsonValue[];
                  sites?: JsonValue[];
                  sentFiles?: JsonValue[];
                },
              ]
            : [],
        );
        return {
          output: limited,
          isError: !result.ok,
          details: {
            calls,
            sandboxCalls: result.calls,
            // Keep independently emitted ordinary tool results in cross-workspace
            // copies. Other output from a memory-reading script may derive from
            // main memory, even when the script transforms or dynamically calls it.
            ...(usedMainMemory
              ? {
                  mainMemoryFreeContent: limited.filter((_, index) => safeBlocks[index]),
                }
              : {}),
            ...(sentFiles.length ? { sentFiles } : {}),
            ...(sites.length ? { sites } : {}),
            ...(battyFileChanges.length ? { battyFileChanges } : {}),
            ...(fileChanges.length ? { fileChanges } : {}),
            ...(forwarded.length
              ? {
                  forwardedArtifacts: {
                    fileChanges: forwarded.flatMap((artifacts) => artifacts.fileChanges ?? []),
                    sites: forwarded.flatMap((artifacts) => artifacts.sites ?? []),
                    sentFiles: forwarded.flatMap((artifacts) => artifacts.sentFiles ?? []),
                  },
                }
              : {}),
          } as unknown as JsonValue,
          ...(control ? { control } : {}),
        };
      } finally {
        await sandbox.close();
        // SDK close() requests shutdown; keep ownership until the worker actually exits.
        await workerExited;
        sandboxes.delete(sandbox);
        // The SDK aborts host callbacks but only joins the VM worker. A callback may
        // still be admitting a durable child and have not registered its cleanup yet.
        await Promise.allSettled(activeCalls);
        await Promise.all(aborts);
        if (abortErrors.length)
          throw new AggregateError(abortErrors, "Failed to cancel nested codemode tools");
      }
    },
  });
}
