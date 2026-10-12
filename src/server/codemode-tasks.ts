import type { Context, JsonValue } from "@earendil-works/chord";
import {
  defineDoc,
  defineTask,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
  type TaskRuntime,
  type RunningTask,
} from "@earendil-works/pi-durable";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { McpService } from "./mcp-service";
import { cancelPersistentBashJob } from "./durable-bash-cancel";

type Input = { name: string; args: JsonValue; callId: string };
type State = { phase: "call" } | { phase: "execute"; replay: "safe" | "unsafe" };
type Result = { result: ToolExecutionResult; structured: JsonValue | null };
const NestedDetails = defineDoc<{ details: JsonValue }>({
  kind: "batty.codemode-nested-details",
  version: 1,
  scope: "task",
  initial: () => ({ details: null }),
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
  ): Promise<ToolExecutionApi> {
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
      output: () => {},
      // Nested calls retain their returned content, not a running-output tail.
      outputWindow: undefined,
      diagnostic: () => {},
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
          id = await tx.createTask(task, input, options);
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
    const api = await apiFor(runtime, task.input.callId, ctx);
    const tool = (await resolve(api, ctx)).find((tool) => tool.name === task.input.name);
    if (!tool) throw new Error(`Unknown nested tool: ${task.input.name}`);
    if (
      recovery &&
      task.state.checkpoint.phase === "execute" &&
      task.state.checkpoint.replay === "unsafe"
    ) {
      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: {
            status: "completed",
            result: {
              result: {
                isError: true,
                content: [{ type: "text", text: "Nested tool interrupted by restart" }],
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
    const result = await tool.execute(
      task.input.args as never,
      api,
      withAbortSignal(runtime.signal, ctx),
    );
    const details = (await runtime.snapshot(NestedDetails, runtime.taskId, ctx))?.details;
    const value = {
      result: {
        ...result,
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

  const nested = defineTask<Input, State, Result>({
    name: "batty.codemode-tool",
    version: 1,
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
