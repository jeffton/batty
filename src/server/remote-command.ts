import {
  defineDocFamily,
  defineTask,
  type Conversation,
  type Harness,
  type TaskId,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { WorkerInputFile } from "./worker-files";
import type { WorkerCommand, WorkerCommandContext } from "./orchestration-workers";

import type { AuthenticatedSteeringPeer } from "./orchestration-state";

type CommandResult = {
  output?: JsonValue;
  details?: JsonValue;
  control?: JsonValue;
  isError?: boolean;
};
const Receipt = defineDocFamily<
  { taskId?: TaskId<CommandResult>; args?: string },
  Record<string, never>
>({
  kind: "batty.node-command",
  checkpointWhen: () => false,
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({}),
});

/** Node commands use the ordinary worker lifecycle, with a durable command task as replay identity. */
export function createRemoteCommands(
  execute: (
    args: WorkerCommand,
    api: WorkerCommandContext,
    ctx: typeof context,
  ) => Promise<unknown>,
  host: () => { harness: Harness; main: Conversation },
) {
  const Command = defineTask<
    {
      args: WorkerCommand;
      grantId: string | null;
      requestId: string;
      files?: WorkerInputFile[];
      steeringPeer?: AuthenticatedSteeringPeer;
    },
    { phase: "execute" },
    CommandResult
  >({
    name: "batty.node-command",
    version: 1,
    initial: () => ({ phase: "execute" }),
    phases: {
      execute: async (task, runtime, ctx) => {
        const { harness, main } = host();
        const api: WorkerCommandContext = {
          taskId: runtime.taskId,
          conversationId: main.id,
          snapshot: runtime.snapshot.bind(runtime),
          commit: (fn, context) => main.commit(fn, context),
          memo: runtime.memo.bind(runtime),
          agent: runtime.agent.bind(runtime),
          getTask: runtime.getTask.bind(runtime),
          waitForTask: runtime.waitForTask.bind(runtime),
          conversation: (id, context) => harness.conversation(id, context),
          details: async () => {},
          ...(task.input.grantId !== null
            ? { remoteAssignment: { grantId: task.input.grantId, requestId: task.input.requestId } }
            : {}),
          inputFiles: task.input.files,
          steeringPeer: task.input.steeringPeer,
          ...(task.input.args.action === "reply" ? { ownerReply: true } : {}),
        };
        let result: CommandResult;
        try {
          result = JSON.parse(
            JSON.stringify(await execute(task.input.args, api, ctx)),
          ) as CommandResult;
        } catch (error) {
          result = {
            output: [{ type: "text", text: String(error) }],
            details: { error: String(error) },
            isError: true,
          };
        }
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result } }),
          ctx,
        );
      },
    },
    abort: async (_, runtime, ctx) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });
  return {
    Command,
    async execute(
      grantId: string | null,
      requestId: string,
      args: WorkerCommand,
      files?: WorkerInputFile[],
      steeringPeer?: AuthenticatedSteeringPeer,
    ) {
      if (!requestId.trim()) throw new Error("Worker command requires requestId");
      if (grantId === null && args.action !== "reply")
        throw new Error("Owner commands only support replying");
      if (args.action === "report") throw new Error("Reports originate in the assigned worker");
      const { harness, main } = host();
      const id = await main.commit(async (tx) => {
        const receipt = await tx.doc(Receipt, JSON.stringify([grantId, requestId]), {});
        const serialized = JSON.stringify(files ? { ...args, inputFiles: files } : args);
        if (receipt.taskId !== undefined) {
          if (receipt.args !== serialized)
            throw new Error("Node requestId was reused with different arguments");
          return receipt.taskId;
        }
        receipt.args = serialized;
        receipt.taskId = await tx.createTask(
          Command,
          {
            args,
            grantId,
            requestId,
            ...(files ? { files } : {}),
            ...(steeringPeer ? { steeringPeer } : {}),
          },
          { ownership: { kind: "conversation" }, background: true },
        );
        return receipt.taskId;
      }, context);
      harness.resume();
      const settled = await harness.waitForTask(id, context);
      if (settled.state.outcome.status !== "completed")
        throw new Error(`Node command ${settled.state.outcome.status}`);
      return settled.state.outcome.result;
    },
  };
}
