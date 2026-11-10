import type { RpcContext, RpcReply } from "./channel";

export type RpcEvents<Events, K> = K extends keyof Events ? Events[K] : never;
export type RpcResult<Outputs, Events, K extends keyof Outputs> = RpcReply<
  Outputs[K],
  RpcEvents<Events, K>
>;
type Operation = (input: unknown, context: RpcContext) => Promise<RpcReply>;
type Handler<Input, Output> = (input: Input, context: RpcContext) => Output | Promise<Output>;

/** An explicit operation allowlist. Validation and authorization remain with its owner. */
export function rpcRegistry<Inputs, Outputs extends Record<keyof Inputs, unknown>, Events = {}>(
  operations = new Map<string, Operation>(),
) {
  return {
    operations,
    add<K extends keyof Inputs & string>(name: K, run: Handler<Inputs[K], Outputs[K]>) {
      operations.set(name, async (input, context) => ({
        value: await run(input as Inputs[K], context),
      }));
    },
    streaming<K extends keyof Inputs & string>(
      name: K,
      run: Handler<Inputs[K], RpcResult<Outputs, Events, K>>,
    ) {
      operations.set(name, async (input, context) => run(input as Inputs[K], context));
    },
  };
}
