import type { Context, JsonValue } from "@earendil-works/chord";
import {
  defineTool,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Compile } from "typebox/compile";
import { Type } from "typebox";
import type { McpService } from "./mcp-service";

export type CodemodeResult = { result: ToolExecutionResult; structured: JsonValue | null };
export const codemodeAdapterName = (replay: "safe" | "unsafe") => `batty_codemode_${replay}`;

/** Native nested receipts retire with their caller; the envelope preserves Batty's program contract. */
export function createCodemodeAdapters(
  resolve: (api: ToolExecutionApi, ctx: Context) => Promise<ToolRegistration[]>,
  mcp: McpService,
) {
  return (["safe", "unsafe"] as const).map((replay) =>
    defineTool({
      name: codemodeAdapterName(replay),
      description: "Internal codemode result adapter",
      callers: ["tools"],
      replay,
      parameters: Type.Object({ name: Type.String(), args: Type.Any() }),
      structuredOutputSchema: Type.Any(),
      execute: async ({ name, args }, api, ctx) => {
        const tool = (await resolve(api, ctx)).find((tool) => tool.name === name);
        if (!tool || name === "codemode" || name.startsWith("batty_codemode_"))
          throw new Error(`Unknown nested tool: ${name}`);
        if ((tool.replay ?? "unsafe") !== replay)
          throw new Error(`Nested tool ${name} replay policy changed`);
        const validator = Compile(tool.parameters);
        if (!validator.Check(args)) throw new Error(`Invalid arguments for ${name}`);
        let output = "";
        const diagnostics: import("@earendil-works/pi-durable").ToolDiagnostic[] = [];
        let details: JsonValue | undefined;
        const result = await tool.execute(
          args,
          {
            ...api,
            executeTool: async (name, args, context, options) => {
              const target = (await resolve(api, context)).find((tool) => tool.name === name);
              if (!target) throw new Error(`Unknown nested tool: ${name}`);
              const nested = await api.executeTool(
                codemodeAdapterName(target.replay ?? "unsafe"),
                { name, args },
                context,
                options,
              );
              if (nested.isError || nested.structuredOutput === undefined) return nested;
              const { result, structured } = nested.structuredOutput as unknown as CodemodeResult;
              const output = result.output ?? [];
              return {
                taskId: nested.taskId,
                structuredOutput:
                  result.structuredOutput ??
                  structured ??
                  ((output.length === 0
                    ? ""
                    : output.length === 1
                      ? output[0]!.type === "text"
                        ? output[0]!.text
                        : output[0]!
                      : output) as JsonValue),
                isError: result.isError ?? false,
                diagnostics: result.diagnostics ?? [],
                ...(result.details === undefined ? {} : { details: result.details }),
                ...(result.usage === undefined ? {} : { usage: result.usage }),
              };
            },
            outputWindow: undefined,
            output: (chunk) => {
              output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
            },
            retainedOutput: () => ({ text: output, truncated: false }),
            diagnostic: (value) => {
              diagnostics.push(value);
            },
            details: async (value, context) => {
              details = value;
              await api.details(value, context);
            },
          },
          ctx,
        );
        if (
          tool.structuredOutputSchema &&
          !(result.isError && result.structuredOutput === undefined)
        ) {
          const validator = Compile(tool.structuredOutputSchema);
          if (!validator.Check(result.structuredOutput))
            throw new Error(
              `Invalid structured output for ${name}: ${JSON.stringify([...validator.Errors(result.structuredOutput)])}`,
            );
        }
        const envelope: CodemodeResult = {
          result: {
            ...result,
            output: result.output ?? [{ type: "text", text: output }],
            diagnostics: [...diagnostics, ...(result.diagnostics ?? [])],
            ...(result.details === undefined && details !== undefined ? { details } : {}),
          },
          structured: (mcp.structuredResult(result) ?? null) as JsonValue,
        };
        return {
          output: [],
          structuredOutput: JSON.parse(JSON.stringify(envelope)),
          ...(result.usage ? { usage: result.usage } : {}),
        };
      },
    }),
  );
}
