import { expectTypeOf, test } from "vite-plus/test";
import type { OwnerInputs, OwnerOutputs, OwnerEvents, OwnerSessionEvent } from "./owner-api";
import { rpcRegistry, type RpcCaller } from "./rpc";
import type { WorkspaceFileSearchEvent } from "./workspace-files";

/** Checked by tsc, never executed: neither side can choose an unrelated wire type. */
function contractChecks(call: RpcCaller<OwnerInputs, OwnerOutputs, OwnerEvents>) {
  const { add, streaming } = rpcRegistry<OwnerInputs, OwnerOutputs, OwnerEvents>();
  add("workspace.git", ({ workspaceId }) => ({ branch: workspaceId }));
  // @ts-expect-error server result must agree with the shared result contract
  add("workspace.git", () => ({ branch: 123 }));
  // @ts-expect-error server input must agree with the shared input contract
  add("workspace.git", (input: { path: string }) => ({ branch: input.path }));
  streaming("session.watch", () => ({
    value: {},
    events: new ReadableStream<OwnerSessionEvent>(),
  }));
  streaming("session.watch", () => ({
    value: {},
    // @ts-expect-error search events cannot be substituted for session events
    events: new ReadableStream<WorkspaceFileSearchEvent>(),
  }));
  streaming("workspace.git", () => ({
    value: { branch: null },
    // @ts-expect-error non-stream operations have no application event type
    events: new ReadableStream<string>(),
  }));
  // @ts-expect-error operation names are an allowlist
  void call("workspace.missing", {});
  // @ts-expect-error required operation inputs cannot be omitted
  void call("session.get", {});
  // @ts-expect-error callers cannot pick their own result type
  void call<number>("workspace.git", { workspaceId: "main" });

  void call("workspace.git", { workspaceId: "main" }).then((reply) => {
    expectTypeOf(reply.value).toEqualTypeOf<{ branch: string | null }>();
  });
  void call("session.watch", { sessionId: "main" }).then((reply) => {
    expectTypeOf(reply.events).toEqualTypeOf<ReadableStream<OwnerSessionEvent> | undefined>();
  });
  void call("workspace.search", { workspaceId: "main", name: "rpc" }).then((reply) => {
    expectTypeOf(reply.events).toEqualTypeOf<
      ReadableStream<WorkspaceFileSearchEvent> | undefined
    >();
  });
}

test("owner calls and registrations share input, result and event contracts", () => {
  expectTypeOf(contractChecks).toBeFunction();
  expectTypeOf<keyof OwnerOutputs>().toEqualTypeOf<keyof OwnerInputs>();
});
