import type { RpcCallOptions } from "@/client/lib/rpc";

/** Adapts transcript fixtures' synthetic callbacks to an object subscription, never network I/O. */
export async function fixtureSessionCall(
  operation: string,
  input: unknown,
  options?: RpcCallOptions,
) {
  if (operation !== "session.watch") throw new Error(`Unexpected fixture operation: ${operation}`);
  const FixtureSubscription = (
    globalThis as unknown as {
      SessionSubscription: new (input: unknown) => {
        onopen?: () => void;
        onmessage?: (event: { data: string }) => void;
        onerror?: () => void;
        close(): void;
      };
    }
  ).SessionSubscription;
  const source = new FixtureSubscription(input);
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      source.close();
    }
  };
  const events = new ReadableStream<unknown>({
    start(controller) {
      source.onopen = () => {};
      source.onmessage = ({ data }) => {
        if (!closed) controller.enqueue(JSON.parse(data));
      };
      source.onerror = () => {
        if (!closed) controller.error(new Error("Fixture disconnected"));
      };
      options?.signal?.addEventListener("abort", close, { once: true });
    },
    cancel: close,
  });
  return { value: undefined, events };
}
