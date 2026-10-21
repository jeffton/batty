import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

beforeEach(() => {
  vi.resetModules();
  sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function responses(shellBuild = "new") {
  const reload = vi.fn();
  vi.stubGlobal("window", { location: { reload } });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ buildId: "new" }),
      text: async () => `<meta name="batty-build" content="${shellBuild}">`,
    }),
  );
  return reload;
}

it("defers a changed build during drafts/uploads and focused input, then reloads once", async () => {
  const reload = responses();
  const { initializeBuild, blockAppReload, checkAppUpdate } = await import("./app-updates");
  initializeBuild("old");
  let busy = true;
  const unblock = blockAppReload(() => busy);
  await checkAppUpdate();
  expect(reload).not.toHaveBeenCalled();
  busy = false;
  const input = document.createElement("textarea");
  document.body.append(input);
  input.focus();
  await checkAppUpdate();
  expect(reload).not.toHaveBeenCalled();
  input.blur();
  await checkAppUpdate();
  await checkAppUpdate();
  expect(reload).toHaveBeenCalledOnce();
  unblock();
});

it("uses SSE build IDs without version requests and still verifies the online shell", async () => {
  const reload = responses();
  const { initializeBuild, blockAppReload, checkAppUpdate } = await import("./app-updates");
  initializeBuild("old");
  let busy = true;
  const unblock = blockAppReload(() => busy);
  await checkAppUpdate("old");
  await checkAppUpdate("new");
  expect(fetch).not.toHaveBeenCalled();
  busy = false;
  await checkAppUpdate("new");
  expect(fetch).toHaveBeenCalledOnce();
  expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("/index.html");
  expect(reload).toHaveBeenCalledOnce();
  unblock();
});

it("does not reload an unchanged build", async () => {
  const reload = responses();
  const { initializeBuild, checkAppUpdate } = await import("./app-updates");
  initializeBuild("new");
  await checkAppUpdate();
  expect(reload).not.toHaveBeenCalled();
});

it("rejects an old cached shell and guards against loops across document loads", async () => {
  const reload = responses("old");
  let updates = await import("./app-updates");
  updates.initializeBuild("old");
  await updates.checkAppUpdate();
  expect(reload).not.toHaveBeenCalled();
  responses();
  await updates.checkAppUpdate();
  expect(sessionStorage.getItem("batty:reload-build")).toBe("new");
  vi.resetModules();
  updates = await import("./app-updates");
  updates.initializeBuild("old");
  const secondReload = responses();
  await updates.checkAppUpdate();
  expect(secondReload).not.toHaveBeenCalled();
});

it.each(["old", "new"])(
  "waits out a transient 502 before acting on recovered build %s",
  async (buildId) => {
    vi.useFakeTimers();
    const reload = responses();
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false, status: 502 } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ buildId }) } as Response);
    const updates = await import("./app-updates");
    updates.initializeBuild("old");
    const first = updates.checkAppUpdate();
    const concurrent = updates.checkAppUpdate();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, concurrent]);
    expect(reload).toHaveBeenCalledTimes(buildId === "new" ? 1 : 0);
    expect(fetch).toHaveBeenCalledTimes(buildId === "new" ? 3 : 2);
  },
);

it("surfaces a persistent 502 after bounded retries and allows a later check", async () => {
  vi.useFakeTimers();
  const reload = responses();
  vi.mocked(fetch).mockResolvedValue({ ok: false, status: 502 } as Response);
  const updates = await import("./app-updates");
  updates.initializeBuild("old");
  const failed = expect(updates.checkAppUpdate()).rejects.toThrow("Version check failed: 502");
  await vi.advanceTimersByTimeAsync(10_000);
  await failed;
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(reload).not.toHaveBeenCalled();
  responses();
  await updates.checkAppUpdate();
  expect(sessionStorage.getItem("batty:reload-build")).toBe("new");
});

it("preserves reload blockers and the across-document guard after a 502", async () => {
  vi.useFakeTimers();
  const reload = responses();
  vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 502 } as Response);
  let updates = await import("./app-updates");
  updates.initializeBuild("old");
  const unblock = updates.blockAppReload(() => true);
  const checking = updates.checkAppUpdate();
  await vi.advanceTimersByTimeAsync(5_000);
  await checking;
  expect(reload).not.toHaveBeenCalled();
  unblock();
  await updates.checkAppUpdate();
  expect(reload).toHaveBeenCalledOnce();
  vi.resetModules();
  updates = await import("./app-updates");
  updates.initializeBuild("old");
  const secondReload = responses();
  vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 502 } as Response);
  const resumed = updates.checkAppUpdate();
  await vi.advanceTimersByTimeAsync(5_000);
  await resumed;
  expect(secondReload).not.toHaveBeenCalled();
});

it("waits for an available matching shell before reloading", async () => {
  vi.useFakeTimers();
  const reload = responses();
  vi.mocked(fetch)
    .mockResolvedValueOnce({ ok: true, json: async () => ({ buildId: "new" }) } as Response)
    .mockResolvedValueOnce({ ok: false, status: 502 } as Response);
  const updates = await import("./app-updates");
  updates.initializeBuild("old");
  const checking = updates.checkAppUpdate();
  await vi.advanceTimersByTimeAsync(4_999);
  expect(reload).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await checking;
  expect(reload).toHaveBeenCalledOnce();
});

it("releases a failed check so resume can retry", async () => {
  const reload = responses();
  vi.mocked(fetch).mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"));
  const updates = await import("./app-updates");
  updates.initializeBuild("old");
  await expect(updates.checkAppUpdate()).rejects.toThrow("Timed out");
  await updates.checkAppUpdate();
  expect(reload).toHaveBeenCalledOnce();
});
