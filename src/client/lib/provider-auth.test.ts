import { effectScope, nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { getOpenAIAuthAttemptStatus } from "./api";
import { watchOpenAIAuthAttempt } from "./provider-auth";

vi.mock("./api", () => ({ getOpenAIAuthAttemptStatus: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("OpenAI auth completion polling", () => {
  it("refreshes after a local callback completes without pasted input", async () => {
    vi.useFakeTimers();
    vi.mocked(getOpenAIAuthAttemptStatus)
      .mockResolvedValueOnce({ completed: false })
      .mockResolvedValueOnce({ completed: true });
    const id = ref("");
    const completed = vi.fn(async () => {
      id.value = "";
    });
    const error = vi.fn();
    const scope = effectScope();
    scope.run(() => watchOpenAIAuthAttempt(id, completed, error));
    id.value = "attempt-1";
    await nextTick();
    await vi.advanceTimersByTimeAsync(2000);
    expect(getOpenAIAuthAttemptStatus).toHaveBeenCalledWith("attempt-1");
    expect(completed).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(getOpenAIAuthAttemptStatus).toHaveBeenCalledTimes(2);
    scope.stop();
  });

  it("stops polling when manual completion starts or the component unmounts", async () => {
    vi.useFakeTimers();
    vi.mocked(getOpenAIAuthAttemptStatus).mockResolvedValue({ completed: false });
    const id = ref("");
    const scope = effectScope();
    scope.run(() => watchOpenAIAuthAttempt(id, vi.fn(), vi.fn()));
    id.value = "attempt-1";
    await nextTick();
    id.value = "";
    await nextTick();
    await vi.advanceTimersByTimeAsync(2000);
    expect(getOpenAIAuthAttemptStatus).not.toHaveBeenCalled();
    id.value = "attempt-2";
    await nextTick();
    scope.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(getOpenAIAuthAttemptStatus).not.toHaveBeenCalled();
  });

  it("surfaces callback errors and stops polling", async () => {
    vi.useFakeTimers();
    const failure = new Error("OpenAI rejected the callback");
    vi.mocked(getOpenAIAuthAttemptStatus).mockRejectedValue(failure);
    const id = ref("");
    const error = vi.fn();
    const scope = effectScope();
    scope.run(() => watchOpenAIAuthAttempt(id, vi.fn(), error));
    id.value = "attempt-1";
    await nextTick();
    await vi.advanceTimersByTimeAsync(3000);
    expect(error).toHaveBeenCalledWith(failure);
    expect(getOpenAIAuthAttemptStatus).toHaveBeenCalledOnce();
    scope.stop();
  });
});
