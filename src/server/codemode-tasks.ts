import type { Context, JsonValue } from "@earendil-works/chord";
import {
  defineDoc,
  defineTask,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
  type TaskRuntime,
  type RunningTask,
  type TaskId,
  type ToolDiagnostic,
} from "@earendil-works/pi-durable";
import { withAbortSignal } from "@earendil-works/chord/context";
import { Compile } from "typebox/compile";
import type { McpService } from "./mcp-service";
import { cancelPersistentBashJob } from "./durable-bash-cancel";

type Input = { name: string; args: JsonValue; callId: string };
type State = { phase: "call" } | { phase: "execute"; replay: "safe" | "unsafe" };
type Result = { result: ToolExecutionResult; structured: JsonValue | null };

/** Migrate completed v1 receipts as well as live tasks; terminal receipts do not run task migrations. */
export function migrateNestedToolResult(result: ToolExecutionResult): ToolExecutionResult {
  if (!("content" in result)) return result;
  const { content, ...rest } = result as ToolExecutionResult & {
    content: ToolExecutionResult["output"];
  };
  return { ...rest, output: content };
}
const NestedDetails = defineDoc<{ details: JsonValue }>({
  kind: "batty.codemode-nested-details",
  version: 1,
  scope: "task",
  initial: () => ({ details: null }),
});

const NestedCalls = defineDoc<{
  calls: Record<string, { taskId: number; name: string; args: JsonValue }>;
}>({
  kind: "batty.codemode-tool-calls",
  version: 1,
  scope: "task",
  initial: () => ({ calls: {} }),
});

/** Nested calls get real task identities, so orchestration receipts and bash jobs never collide. */
export function createCodemodeTasks(
  resolve: (api: ToolExecutionApi, ctx: Context) => Promise<ToolRegistration[]>,
  mcp: McpService,
  jobsDir: string,
) {
  async function apiFor(
    runtime: TaskRuntime<Input, State, Result, object>,
    callId: string,
    ctx: Context,
    reported: { output: string; diagnostics: ToolDiagnostic[]; replay: "safe" | "unsafe" },
    admissions: Promise<TaskId<Result>>[],
  ): Promise<ToolExecutionApi> {
    let sequence = 0;
    return {
      taskId: runtime.taskId,
      conversationId: runtime.conversationId,
      callId,
      registry: runtime.registry,
      models: runtime.models,
      env: await runtime.env(ctx),
      agent: runtime.agent.bind(runtime),
      snapshot: runtime.snapshot.bind(runtime),
      snapshotAsOf: runtime.snapshotAsOf.bind(runtime),
      watchDoc: runtime.watchDoc.bind(runtime),
      memo: runtime.memo.bind(runtime),
      getTask: runtime.getTask.bind(runtime),
      waitForTask: runtime.waitForTask.bind(runtime),
      conversation: runtime.conversation.bind(runtime),
      output: (chunk) => {
        reported.output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      },
      // Nested calls retain their returned output, not a running-output tail.
      outputWindow: undefined,
      retainedOutput: () => ({ text: reported.output, truncated: false }),
      diagnostic: (diagnostic) => {
        reported.diagnostics.push(diagnostic);
      },
      executeTool: async (name, args, context, options = {}) => {
        const key = options.key ?? String(++sequence);
        const admission = (async () => {
          let taskId!: TaskId<Result>;
          await runtime.commit(async (tx) => {
            const calls = await tx.doc(NestedCalls, runtime.taskId);
            const recorded = calls.calls[key];
            if (recorded) {
              if (recorded.name !== name || JSON.stringify(recorded.args) !== JSON.stringify(args))
                throw new Error(`Nested call ${key} changed during replay`);
              taskId = recorded.taskId as TaskId<Result>;
              return;
            }
            const id = await tx.createTask(
              nested,
              { name, args: args as JsonValue, callId: `${callId}/${key}` },
              {
                ownership: { kind: "task", taskId: runtime.taskId },
                abandonOnRestart: reported.replay === "unsafe",
              },
            );
            calls.calls[key] = { taskId: id, name, args: args as JsonValue };
            taskId = id;
          }, context);
          return taskId;
        })();
        admissions.push(admission);
        const taskId = await admission;
        const settled = await runtime.waitForTask(taskId, context);
        const outcome = settled.state.outcome;
        if (outcome.status !== "completed")
          throw new Error(`Nested tool ${name} ${outcome.status}`);
        const { structured } = outcome.result;
        const result = migrateNestedToolResult(outcome.result.result);
        const output = result.output ?? [];
        const only = output[0];
        return {
          taskId: taskId as TaskId,
          structuredOutput:
            result.structuredOutput !== undefined
              ? result.structuredOutput
              : (structured ??
                ((output.length === 0
                  ? ""
                  : output.length === 1
                    ? only!.type === "text"
                      ? only!.text
                      : only!
                    : output) as JsonValue)),
          isError: result.isError ?? false,
          diagnostics: result.diagnostics ?? [],
          ...(result.details === undefined ? {} : { details: result.details }),
          ...(result.usage === undefined ? {} : { usage: result.usage }),
        };
      },
      details: async (details, context) => {
        await runtime.commit(async (tx) => {
          (await tx.doc(NestedDetails, runtime.taskId)).details = JSON.parse(
            JSON.stringify(details),
          );
        }, context);
      },
      commit: async (change, context) => {
        let result: unknown;
        await runtime.commit(async (tx) => {
          result = await change(tx);
        }, context);
        return result as never;
      },
      createTask: async (task, input, options, context) => {
        let id: any;
        await runtime.commit(async (tx) => {
          id = await tx.createTask(
            task,
            input,
            options.ownership.kind === "task" && reported.replay === "unsafe"
              ? { abandonOnRestart: true, ...options }
              : options,
          );
        }, context);
        return id;
      },
    };
  }

  async function execute(
    task: RunningTask<Input, State, Result>,
    runtime: TaskRuntime<Input, State, Result, object>,
    ctx: Context,
    recovery: boolean,
  ) {
    const reported = {
      output: "",
      diagnostics: [] as ToolDiagnostic[],
      replay: "unsafe" as "safe" | "unsafe",
    };
    const admissions: Promise<TaskId<Result>>[] = [];
    const api = await apiFor(runtime, task.input.callId, ctx, reported, admissions);
    const tool = (await resolve(api, ctx)).find((tool) => tool.name === task.input.name);
    if (!tool) throw new Error(`Unknown nested tool: ${task.input.name}`);
    reported.replay = tool.replay ?? "unsafe";
    if (
      recovery &&
      task.state.checkpoint.phase === "execute" &&
      task.state.checkpoint.replay === "unsafe"
    ) {
      await abortChildren(runtime, ctx);
      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: {
            status: "completed",
            result: {
              result: {
                isError: true,
                output: [{ type: "text", text: "Nested tool interrupted by restart" }],
              },
              structured: null,
            },
          },
        }),
        ctx,
      );
      return;
    }
    if (!recovery)
      await runtime.commit(
        () => ({
          status: "running",
          checkpoint: { phase: "execute", replay: tool.replay ?? "unsafe" },
        }),
        ctx,
      );
    const argumentValidator = Compile(tool.parameters);
    if (!argumentValidator.Check(task.input.args))
      throw new Error(
        `Invalid arguments for ${tool.name}: ${JSON.stringify([...argumentValidator.Errors(task.input.args)])}`,
      );
    let result: ToolExecutionResult;
    try {
      result = await tool.execute(
        task.input.args as never,
        api,
        withAbortSignal(runtime.signal, ctx),
      );
    } finally {
      // Shutdown leaves safe work resumable; normal settlement cancels anything the caller left running.
      if (!ctx.abortSignal?.aborted && !runtime.signal.aborted) {
        await Promise.allSettled(admissions);
        await abortChildren(runtime, ctx);
      }
    }
    if (tool.structuredOutputSchema && !(result.isError && result.structuredOutput === undefined)) {
      const validator = Compile(tool.structuredOutputSchema);
      if (!validator.Check(result.structuredOutput))
        throw new Error(
          `Invalid structured output for ${tool.name}: ${JSON.stringify([...validator.Errors(result.structuredOutput)])}`,
        );
    }
    const details = (await runtime.snapshot(NestedDetails, runtime.taskId, ctx))?.details;
    const value = {
      result: {
        ...result,
        output: result.output ?? [{ type: "text", text: reported.output }],
        diagnostics: [...reported.diagnostics, ...(result.diagnostics ?? [])],
        ...(result.details === undefined && details !== null && details !== undefined
          ? { details }
          : {}),
      },
      structured: mcp.structuredResult(result) ?? null,
    };
    await runtime.commit(
      () => ({
        status: "terminal",
        outcome: { status: "completed", result: JSON.parse(JSON.stringify(value)) },
      }),
      ctx,
    );
  }

  async function abortChildren(runtime: TaskRuntime<Input, State, Result, object>, ctx: Context) {
    await Promise.all(
      (await runtime.ownedTasks(ctx)).map((task) => runtime.abortOwned(task.id, ctx)),
    );
  }

  const nested = defineTask<Input, State, Result>({
    name: "batty.codemode-tool",
    version: 2,
    migrate: (input, checkpoint) => ({ input: input as Input, checkpoint: checkpoint as State }),
    initial: () => ({ phase: "call" }),
    phases: {
      call: (task, runtime, ctx) => execute(task, runtime, ctx, false),
      execute: (task, runtime, ctx) => execute(task, runtime, ctx, true),
    },
    abort: async (task, runtime, ctx) => {
      if (task.input.name === "bash")
        await cancelPersistentBashJob(
          jobsDir,
          `${runtime.conversationId}-${runtime.taskId}-${task.input.callId}`,
        );
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });
  return nested;
}
