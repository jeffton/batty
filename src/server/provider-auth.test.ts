// @vitest-environment node
import { expect, it, vi } from "vite-plus/test";
import { ProviderAuthService } from "./provider-auth";

it("publishes safe completion snapshots and retains manually completed attempts", async () => {
  const runtime = {
    login: vi.fn(async (_provider: string, _method: string, options: any) => {
      options.notify({ type: "auth_url", url: "https://example.test/login?secret=not-in-status" });
      await options.prompt({ type: "input" });
    }),
  };
  const service = new ProviderAuthService(
    runtime as any,
    () => undefined,
    () => "device",
  );
  const changes = vi.fn();
  const unsubscribe = service.subscribeAttempts(changes);
  const started = await service.start("openai");
  expect(changes).toHaveBeenLastCalledWith({ attemptId: started.attemptId, completed: false });
  await service.complete(started.attemptId, "private-callback-code");
  expect(changes).toHaveBeenLastCalledWith({ attemptId: started.attemptId, completed: true });
  expect(service.listAuthAttempts()).toEqual([{ attemptId: started.attemptId, completed: true }]);
  expect(JSON.stringify(changes.mock.calls)).not.toContain("private-callback-code");
  expect(JSON.stringify(changes.mock.calls)).not.toContain("not-in-status");
  unsubscribe();
  await service.dispose();
});

it("publishes failure without status polling", async () => {
  const finish = Promise.withResolvers<void>();
  const runtime = {
    login: vi.fn(async (_provider: string, _method: string, options: any) => {
      options.notify({ type: "auth_url", url: "https://example.test" });
      await finish.promise;
    }),
  };
  const service = new ProviderAuthService(
    runtime as any,
    () => undefined,
    () => "device",
  );
  const changes = vi.fn();
  service.subscribeAttempts(changes);
  const started = await service.start("openai");
  finish.reject(new Error("Sign-in failed"));
  await vi.waitFor(() =>
    expect(changes).toHaveBeenLastCalledWith({
      attemptId: started.attemptId,
      completed: false,
      error: "Sign-in failed",
    }),
  );
  await service.dispose();
});
