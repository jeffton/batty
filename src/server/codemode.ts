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
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import type { McpService } from "./mcp-service";
import type { CodemodeCall } from "../shared/types";
import type { createCodemodeTasks } from "./codemode-tasks";
import { MAIN_MEMORY_TOOLS } from "./main-memory-policy";
import { isPiShellToolName } from "../shared/pi-tools";

export const CodemodeCalls = defineDoc<{
  calls: Record<string, { taskId: number; name: string; args: JsonValue }>;
}>({ kind: "batty.codemode-calls", version: 1, scope: "task", initial: () => ({ calls: {} }) });

export const CodemodeStore = defineDoc<{ values: Record<string, JsonValue> }>({
  kind: "batty.codemode-store",
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
  nested: ReturnType<typeof createCodemodeTasks>,
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
      const memoryImages: ImageContent[] = [];
      let usedMainMemory = false;
      let ordinal = 0;
      const aborts: Promise<void>[] = [];
      const abortErrors: unknown[] = [];
      let control: import("@earendil-works/pi-durable").ToolControl | undefined;
      const tools: CodemodeTool[] = registrations.map((tool) => ({
        name: tool.name,
        description: tool.description,
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
            : { type: "string" },
        execute: async (input, { signal }) => {
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
            const taskId = await api.commit(async (tx) => {
              const journal = await tx.doc(CodemodeCalls, api.taskId);
              const recorded = journal.calls[index];
              if (recorded) {
                if (
                  recorded.name !== tool.name ||
                  JSON.stringify(recorded.args) !== JSON.stringify(args)
                )
                  throw new Error(`Codemode replay changed nested call ${index}`);
                return recorded.taskId as import("@earendil-works/pi-durable").TaskId<{
                  result: import("@earendil-works/pi-durable").ToolExecutionResult;
                  structured: JsonValue | null;
                }>;
              }
              const taskId = await tx.createTask(
                nested,
                { name: tool.name, args: args as JsonValue, callId: `${api.callId}-${index}` },
                { ownership: { kind: "task", taskId: api.taskId } },
              );
              journal.calls[index] = { taskId, name: tool.name, args: args as JsonValue };
              return taskId;
            }, ctx);
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
            const { result, structured } = outcome.result;
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
            if (tool.name === "memory_zoom" && !result.isError)
              memoryImages.push(...(result.output ?? []).filter((block) => block.type === "image"));
            if (result.isError && result.structuredOutput === undefined) throw new Error(text);
            call.status = result.isError ? "error" : "ok";
            if (result.structuredOutput !== undefined) return result.structuredOutput;
            if (structured !== null) return structured;
            return text;
          } catch (error) {
            if (call.status !== "cancelled") call.status = "error";
            call.error = error instanceof Error ? error.message : String(error);
            throw error;
          } finally {
            call.durationMs = performance.now() - started;
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
      const sandbox = new CodemodeSandbox({
        tools,
        globals,
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
        const content = [...result.output, ...memoryImages];
        if (result.ok && result.value !== undefined)
          content.push({
            type: "text",
            text: typeof result.value === "string" ? result.value : JSON.stringify(result.value),
          });
        if (!result.ok)
          content.push({ type: "text", text: result.error.stack ?? result.error.message });
        let budget = (parsed.options.maxOutputTokens ?? 10000) * 4;
        const safeBlocks = content.map(
          (block) => block.type === "text" && ordinaryOutputs.has(block.text),
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
        sandboxes.delete(sandbox);
        await sandbox.close();
        await Promise.all(aborts);
        if (abortErrors.length)
          throw new AggregateError(abortErrors, "Failed to cancel nested codemode tools");
      }
    },
  });
}
