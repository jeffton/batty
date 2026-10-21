import { effectScope, reactive, ref, nextTick } from "vue";
import { expect, it, vi } from "vite-plus/test";
import { watchOpenAIAuthAttempt } from "./provider-auth";
import { getOpenAIAuthAttemptStatus } from "./api";
import type { ProviderAuthAttemptStatus } from "@/shared/types";

const state = reactive({
  authAttemptsVersion: 0,
  providerAuthAttempts: {} as Record<string, ProviderAuthAttemptStatus>,
});
vi.mock("@/client/stores/app", () => ({ useAppStore: () => state }));
vi.mock("./api", () => ({ getOpenAIAuthAttemptStatus: vi.fn() }));

it("uses completion received before the start response without requesting status", async () => {
  const scope = effectScope();
  const id = ref("");
  const completed = vi.fn(async () => {});
  const error = vi.fn();
  state.providerAuthAttempts.early = { attemptId: "early", completed: true };
  scope.run(() => watchOpenAIAuthAttempt(id, completed, error));
  id.value = "early";
  await nextTick();
  expect(completed).toHaveBeenCalledTimes(1);
  expect(getOpenAIAuthAttemptStatus).not.toHaveBeenCalled();
  scope.stop();
});

it("reconciles a missing reconnect snapshot once and lets SSE beat a late GET", async () => {
  const scope = effectScope();
  const pending = Promise.withResolvers<{ completed: boolean }>();
  vi.mocked(getOpenAIAuthAttemptStatus).mockReturnValueOnce(pending.promise);
  const completed = vi.fn(async () => {});
  const error = vi.fn();
  scope.run(() => watchOpenAIAuthAttempt(ref("reconnect"), completed, error));
  state.providerAuthAttempts.reconnect = { attemptId: "reconnect", completed: true };
  await nextTick();
  pending.resolve({ completed: false });
  await nextTick();
  expect(completed).toHaveBeenCalledTimes(1);
  expect(error).not.toHaveBeenCalled();
  scope.stop();
});

it("recovers from a transient reconciliation failure through later SSE", async () => {
  const scope = effectScope();
  vi.mocked(getOpenAIAuthAttemptStatus).mockRejectedValueOnce(new TypeError("Failed to fetch"));
  const completed = vi.fn(async () => {});
  const error = vi.fn();
  scope.run(() => watchOpenAIAuthAttempt(ref("offline"), completed, error));
  await nextTick();
  await nextTick();
  expect(error).not.toHaveBeenCalled();
  state.providerAuthAttempts.offline = { attemptId: "offline", completed: true };
  await nextTick();
  expect(completed).toHaveBeenCalledTimes(1);
  scope.stop();
});

it("reports a vanished server attempt after reconnect without a timer", async () => {
  const scope = effectScope();
  state.providerAuthAttempts.vanished = { attemptId: "vanished", completed: false };
  const error = vi.fn();
  scope.run(() => watchOpenAIAuthAttempt(ref("vanished"), vi.fn(), error));
  vi.mocked(getOpenAIAuthAttemptStatus).mockRejectedValueOnce(
    Object.assign(new Error("Unknown auth attempt"), { status: 404 }),
  );
  delete state.providerAuthAttempts.vanished;
  state.authAttemptsVersion++;
  await nextTick();
  await nextTick();
  expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: "Unknown auth attempt" }));
  scope.stop();
});
