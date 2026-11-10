import type { RpcContext, RpcReply } from "./channel";

type Operation = (input: unknown, context: RpcContext) => Promise<RpcReply>;
type Handler<Input, Output> = (input: Input, context: RpcContext) => Output | Promise<Output>;

/** An explicit operation allowlist. Validation and authorization remain with its owner. */
export function rpcRegistry<Inputs>(operations = new Map<string, Operation>()) {
  return {
    operations,
    add<K extends keyof Inputs & string>(name: K, run: Handler<Inputs[K], unknown>) {
      operations.set(name, async (input, context) => ({
        value: await run(input as Inputs[K], context),
      }));
    },
    streaming<K extends keyof Inputs & string>(name: K, run: Handler<Inputs[K], RpcReply>) {
      operations.set(name, async (input, context) => run(input as Inputs[K], context));
    },
  };
}
