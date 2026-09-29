import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import {
  CodemodeSandbox,
  loadQuickJSWasm,
  parseCodemodeSource,
  renderDeclarations,
  type CodemodeCall,
  type CodemodeJsonSchema,
  type CodemodeOutputItem,
  type CodemodeStoreWrites,
  type CodemodeTool,
} from "@earendil-works/pi-codemode";
import { Type } from "typebox";
import type { DurableFileChange } from "./agent-turn-file-changes";
import type { HarnessSessionStore } from "./harness-session-store";
import type { SentFileDescriptor, SiteDescriptor } from "@/shared/types";

const schema = Type.Object({
  code: Type.String({ description: "JavaScript source, with top-level await and return." }),
});
const DEFAULT_OUTPUT_TOKENS = 10_000;

interface CodemodeDetails {
  codemode: {
    calls: CodemodeCall[];
    storeWrites?: CodemodeStoreWrites;
  };
  battyFileChanges: DurableFileChange[];
  sentFiles: SentFileDescriptor[];
  sites: SiteDescriptor[];
  battyToolError?: true;
}

function readStore(session: HarnessSessionStore): Record<string, unknown> {
  const store: Record<string, unknown> = Object.create(null);
  for (const entry of session.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    if (entry.message.toolName !== "codemode" || entry.message.isError) continue;
    const writes = (entry.message.details as CodemodeDetails | undefined)?.codemode.storeWrites;
    if (!writes) continue;
    for (const key of writes.delete) delete store[key];
    Object.assign(store, writes.set);
  }
  return store;
}

function textOf(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

async function limitOutput(
  items: CodemodeOutputItem[],
  maxTokens: number,
): Promise<CodemodeOutputItem[]> {
  const fullText = items
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  const maxChars = maxTokens * 4;
  if (fullText.length <= maxChars) return items;
  const directory = await mkdtemp(path.join(os.tmpdir(), "batty-codemode-"));
  const outputPath = path.join(directory, "output.txt");
  await writeFile(outputPath, fullText);
  const head = Math.ceil(maxChars / 2);
  const tail = Math.floor(maxChars / 2);
  return [
    {
      type: "text",
      text: `${fullText.slice(0, head)}\n…${fullText.length - maxChars} chars truncated…\n${tail ? fullText.slice(-tail) : ""}\nFull output: ${outputPath}`,
    },
    ...items.filter((item) => item.type === "image"),
  ];
}

/** Pi handles scripts; the harness owns nested effects and their invocation identity. */
export function createCodemodeTool(
  tools: AgentHarnessTool<ExecutionToolContext, any>[],
  session: HarnessSessionStore,
): AgentHarnessTool<ExecutionToolContext, typeof schema, CodemodeDetails> {
  const declarations = tools.map((tool) => ({
    name: tool.name,
    inputSchema: tool.parameters,
    outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? { type: "string" },
    execute: () => undefined,
  }));
  return {
    name: "codemode",
    label: "codemode",
    replay: "never",
    parameters: schema,
    description: [
      "Run JavaScript to batch or chain tool calls, loop over results, or filter output before returning it to the model.",
      "Use await tools.<name>({...}) or Promise.allSettled for independent calls. Tools remain available for direct calls.",
      "The script is an async function body: top-level await and return work. No Node.js APIs, filesystem, network, timers, or modules are available except through tools.",
      "Output with text(value), console.log(...), image(dataUrlOrImageContent), or return value. exit() ends the script. ALL_TOOLS lists tool names and descriptions.",
      "Tools with an output schema return structured values; other tools return text. Failed tool calls reject with an Error. Earlier tool effects remain if a script fails.",
      "store(key, value) and load(key) keep JSON values across successful scripts on the current session branch.",
      'An optional first line // @options: {"max_output_tokens": 2000, "timeout_ms": 60000} controls output and deadline. Output defaults to 10000 estimated tokens; there is no default deadline.',
      renderDeclarations({ tools: declarations }),
    ].join("\n\n"),
    async execute(_id, { code }, onUpdate, _toolContext, invocation, context) {
      const source = parseCodemodeSource(code);
      const details: CodemodeDetails = {
        codemode: { calls: [] },
        battyFileChanges: [],
        sentFiles: [],
        sites: [],
      };
      let terminate = false;
      const pendingCalls = new Set<Promise<unknown>>();
      const collectArtifacts = (result: AgentToolResult<unknown>) => {
        const artifacts = result.details as Partial<CodemodeDetails> | undefined;
        details.battyFileChanges.push(...(artifacts?.battyFileChanges ?? []));
        details.sentFiles.push(...(artifacts?.sentFiles ?? []));
        details.sites.push(...(artifacts?.sites ?? []));
      };
      const sandboxTools: CodemodeTool[] = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
        outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? { type: "string" },
        execute(args, { signal }) {
          const execution = (async () => {
            const result = await invocation.executeTool(tool.name, args, {
              signal,
              onUpdate(partial) {
                collectArtifacts(partial);
                onUpdate(
                  {
                    content: [{ type: "text", text: `Running ${tool.name}` }],
                    details,
                  },
                  { checkpoint: true },
                );
              },
            });
            collectArtifacts(result);
            terminate ||= result.terminate === true;
            onUpdate(
              {
                content: [{ type: "text", text: `Called ${tool.name}` }],
                details,
              },
              { checkpoint: true },
            );
            if (result.isError) throw new Error(textOf(result));
            return tool.outputSchema && result.structuredContent !== undefined
              ? result.structuredContent
              : textOf(result);
          })().finally(() => pendingCalls.delete(execution));
          pendingCalls.add(execution);
          return execution;
        },
      }));
      const runtime = import.meta.filename.endsWith(".mjs")
        ? {
            workerUrl: new URL("./codemode-worker.mjs", import.meta.url),
            wasm: loadQuickJSWasm(fileURLToPath(new URL("./quickjs.wasm", import.meta.url))),
          }
        : {};
      const sandbox = new CodemodeSandbox({
        tools: sandboxTools,
        timeoutMs: Infinity,
        memoryLimitBytes: 256 * 1024 * 1024,
        ...runtime,
      });
      const started = performance.now();
      try {
        const result = await sandbox.execute(source.code, {
          signal: context.abortSignal,
          timeoutMs: source.options.timeoutMs,
          store: readStore(session),
        });
        // The sandbox cancels unawaited calls but does not join their host-side effects.
        await Promise.allSettled(pendingCalls);
        details.codemode.calls = result.calls;
        if (result.ok) details.codemode.storeWrites = result.storeWrites;
        else details.battyToolError = true;
        const output = [...result.output];
        if (result.ok && result.value !== undefined)
          output.push({ type: "text", text: JSON.stringify(result.value) });
        if (!result.ok)
          output.push({
            type: "text",
            text: `Script error: ${result.error.stack ?? result.error.message}`,
          });
        return {
          content: [
            {
              type: "text",
              text: `Script ${result.ok ? "completed" : "failed"} (${((performance.now() - started) / 1000).toFixed(2)}s)`,
            },
            ...(await limitOutput(output, source.options.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS)),
          ],
          details,
          terminate,
          ...(result.ok ? {} : { isError: true }),
        };
      } finally {
        await sandbox.close();
        await Promise.allSettled(pendingCalls);
      }
    },
  };
}
