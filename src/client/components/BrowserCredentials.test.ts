import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { rpcCall } from "@/client/lib/rpc";
import BrowserCredentials from "./BrowserCredentials.vue";

vi.mock("@/client/lib/rpc", () => ({ rpcCall: vi.fn() }));

const state = {
  pageId: "page-1",
  revision: "revision-1",
  url: "https://login.example/signin",
  title: "Login",
  width: 390,
  height: 800,
  mobile: true,
  deviceScaleFactor: 3,
  pages: [],
  login: { id: "login-form", username: true, password: true },
};
const target = {
  pageId: state.pageId,
  revision: state.revision,
  url: state.url,
  origin: "https://login.example",
  token: "document-token",
  loginId: state.login.id,
};
const username = '[name="username"]';
const password = '[name="password"]';
const rpc = vi.mocked(rpcCall);
const fills = () =>
  rpc.mock.calls.filter(([operation]) => operation === "browser.credentials.fill");
const panel = (props = { browserId: "session", state }) => mount(BrowserCredentials, { props });
const settle = () => vi.advanceTimersByTimeAsync(450);

beforeEach(() => {
  vi.useFakeTimers();
  rpc
    .mockReset()
    .mockImplementation(async (operation) =>
      operation === "browser.credentials.prepare" ? { value: target } : { value: {} },
    );
});
afterEach(() => vi.useRealTimers());

test.each([
  [true, true],
  [true, false],
  [false, true],
])("fills only the remote username=%s, password=%s fields", async (u, p) => {
  const view = panel({
    browserId: "session",
    state: { ...state, login: { ...state.login, username: u, password: p } },
  });
  expect(view.get("form").attributes("aria-label")).toContain(target.origin);
  expect(view.find("button").exists()).toBe(false);
  expect(view.get(username).attributes("autocomplete")).toBe("username");
  expect(view.get(password).attributes("autocomplete")).toBe("current-password");
  await view.get(username).setValue("synthetic-user");
  await view.get(password).setValue("synthetic-password");
  await settle();
  expect(fills()).toMatchObject([
    [
      "browser.credentials.fill",
      {
        browserId: "session",
        credentials: {
          target,
          username: u ? "synthetic-user" : "",
          password: p ? "synthetic-password" : "",
        },
      },
      {},
    ],
  ]);
  expect(view.get<HTMLInputElement>(password).element.value).toBe("synthetic-password");
  view.unmount();
});

test("does not send an incomplete pair or restart the timer on an unchanged event", async () => {
  const view = panel();
  await view.get(username).setValue("synthetic-user");
  await settle();
  expect(rpc).not.toHaveBeenCalled();
  await view.get(password).setValue("partial");
  await vi.advanceTimersByTimeAsync(200);
  await view.get(password).setValue("");
  await settle();
  expect(rpc).not.toHaveBeenCalled();
  await view.get(password).setValue("complete");
  await vi.advanceTimersByTimeAsync(275);
  await view.get(password).trigger("change");
  await vi.advanceTimersByTimeAsync(30);
  expect(fills()).toHaveLength(1);
  await settle();
  expect(fills()).toHaveLength(1);
  view.unmount();
});

test.each([
  { browserId: "new-session", state },
  { browserId: "session", state: { ...state, pageId: "new-tab" } },
  { browserId: "session", state: { ...state, revision: "navigation" } },
  { browserId: "session", state: { ...state, url: "https://login.example/elsewhere" } },
  { browserId: "session", state: { ...state, login: { ...state.login, id: "replacement-form" } } },
])(
  "aborts preparation and forgets local credentials on navigation or identity change",
  async (next) => {
    let release!: () => void;
    rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ value: target });
        }),
    );
    const view = panel();
    await view.get(username).setValue("synthetic-user");
    await view.get(password).setValue("synthetic-password");
    await settle();
    expect(rpc.mock.calls[0]![0]).toBe("browser.credentials.prepare");
    await view.setProps(next);
    release();
    await flushPromises();
    expect(fills()).toHaveLength(0);
    expect(rpc.mock.calls[0]![2]?.signal?.aborted).toBe(true);
    expect(view.get<HTMLInputElement>(password).element.value).toBe("");
    view.unmount();
  },
);

test("preserves edits during an in-flight transfer and serializes the latest correction", async () => {
  let release!: () => void;
  rpc.mockImplementationOnce(async () => ({ value: target }));
  rpc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ value: {} });
      }),
  );
  const view = panel();
  await view.get(username).setValue("synthetic-user");
  await view.get(password).setValue("initial");
  await settle();
  await view.get(password).setValue("correction");
  await settle();
  expect(fills()).toHaveLength(1);
  expect(view.get<HTMLInputElement>(password).element.value).toBe("correction");
  release();
  await flushPromises();
  expect(fills()).toHaveLength(2);
  expect(fills()[1]![1]).toMatchObject({ credentials: { password: "correction" } });
  view.unmount();
});

test("does not send a stale snapshot when input changes during preparation", async () => {
  let release!: () => void;
  rpc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ value: target });
      }),
  );
  const view = panel();
  await view.get(username).setValue("synthetic-user");
  await view.get(password).setValue("initial");
  await settle();
  await view.get(password).setValue("correction");
  release();
  await flushPromises();
  expect(fills()).toHaveLength(0);
  await settle();
  expect(fills()).toHaveLength(1);
  expect(fills()[0]![1]).toMatchObject({ credentials: { password: "correction" } });
  view.unmount();
});

test("clearing a previously sent password cannot let the remote page use the stale value", async () => {
  const view = panel();
  const canInteract = () =>
    (view.vm as unknown as { canInteractWithPage(): boolean }).canInteractWithPage();
  expect(canInteract()).toBe(true);
  await view.get(username).setValue("test-user");
  await view.get(password).setValue("test-password");
  await settle();
  expect(canInteract()).toBe(true);
  await view.get(password).setValue("");
  expect(canInteract()).toBe(false);
  await settle();
  expect(fills()).toHaveLength(1);
  expect(view.get('[role="status"]').text()).toContain("missing field");
  await view.get(password).setValue("test-password");
  expect(canInteract()).toBe(true);
  view.unmount();
});

test("a cancelled composition restarts the debounce that expired without transferring", async () => {
  const view = panel();
  await view.get(username).setValue("test-user");
  await view.get(password).setValue("test-password");
  await view.get(password).trigger("compositionstart");
  await settle();
  expect(fills()).toHaveLength(0);
  await view.get(password).trigger("compositionend");
  await settle();
  expect(fills()).toHaveLength(1);
  view.unmount();
});

test("failed handoff preserves editable values, hides error details and retries with a fresh target", async () => {
  rpc
    .mockResolvedValueOnce({ value: target })
    .mockRejectedValueOnce(new Error("synthetic-password"));
  const view = panel();
  await view.get(username).setValue("synthetic-user");
  await view.get(password).setValue("synthetic-password");
  await settle();
  expect(view.get('[role="alert"]').text()).not.toContain("synthetic-password");
  expect(view.get<HTMLInputElement>(password).element.value).toBe("synthetic-password");
  await view.get('button[type="button"]').trigger("click");
  await flushPromises();
  expect(fills()).toHaveLength(2);
  expect(view.find('[role="alert"]').exists()).toBe(false);
  view.unmount();
});
