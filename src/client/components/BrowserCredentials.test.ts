import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, expect, test, vi } from "vite-plus/test";
import BrowserCredentials from "./BrowserCredentials.vue";

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
afterEach(() => vi.unstubAllGlobals());

test.each([
  [true, true],
  [true, false],
  [false, true],
])(
  "autofill pair stays available for remote username=%s password=%s, with explicit one-shot fill",
  async (usernameField, passwordField) => {
    const fetch = vi
      .fn()
      .mockImplementation(async (url: string) =>
        url.endsWith("/prepare") ? { ok: true, json: async () => target } : { ok: true },
      );
    vi.stubGlobal("fetch", fetch);
    const panel = mount(BrowserCredentials, {
      props: {
        browserId: "session",
        state: {
          ...state,
          login: { ...state.login, username: usernameField, password: passwordField },
        },
      },
    });
    await flushPromises();
    expect(panel.text()).toContain(target.origin);
    expect(panel.get('[name="username"]').attributes("autocomplete")).toBe("username");
    expect(panel.get('[name="password"]').attributes("autocomplete")).toBe("current-password");
    expect(panel.get('[name="username"]').attributes("required") !== undefined).toBe(usernameField);
    expect(panel.get('[name="password"]').attributes("required") !== undefined).toBe(passwordField);
    await panel.get('[name="username"]').setValue("synthetic-user");
    await panel.get('[name="password"]').setValue("synthetic-password");
    expect(fetch).toHaveBeenCalledTimes(1);
    await panel.get("form").trigger("submit");
    await flushPromises();
    expect(fetch.mock.calls[1]![0]).toBe("/api/cloud-browser/session/credentials/fill");
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({
      target,
      username: "synthetic-user",
      password: "synthetic-password",
    });
    expect((panel.get('[name="username"]').element as HTMLInputElement).value).toBe("");
    expect((panel.get('[name="password"]').element as HTMLInputElement).value).toBe("");
    panel.unmount();
  },
);

test.each([
  { ...state, revision: "navigation" },
  { ...state, url: "https://login.example/elsewhere" },
  { ...state, login: { ...state.login, id: "replacement-form" } },
])("navigation or form replacement clears and invalidates local credentials", async (nextState) => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => target });
  vi.stubGlobal("fetch", fetch);
  const panel = mount(BrowserCredentials, { props: { browserId: "session", state } });
  await flushPromises();
  await panel.get('[name="password"]').setValue("synthetic-secret");
  await panel.setProps({ state: nextState });
  expect((panel.get('[name="password"]').element as HTMLInputElement).value).toBe("");
  await panel.get("form").trigger("submit");
  expect(fetch).toHaveBeenCalledTimes(1);
  panel.unmount();
});

test("late preparation for an obsolete document cannot enable filling", async () => {
  let resolve!: (value: unknown) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    ),
  );
  const panel = mount(BrowserCredentials, { props: { browserId: "session", state } });
  await panel.setProps({ state: { ...state, revision: "navigation" } });
  resolve({ ok: true, json: async () => target });
  await flushPromises();
  expect(panel.get('button[type="submit"]').attributes("disabled")).toBeDefined();
  panel.unmount();
});

test("failed handoff clears secrets, hides transport error details and allows explicit retry", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => target })
    .mockRejectedValueOnce(new Error("synthetic-password"))
    .mockResolvedValueOnce({ ok: true, json: async () => target });
  vi.stubGlobal("fetch", fetch);
  const panel = mount(BrowserCredentials, { props: { browserId: "session", state } });
  await flushPromises();
  await panel.get('[name="password"]').setValue("synthetic-password");
  await panel.get("form").trigger("submit");
  await flushPromises();
  expect((panel.get('[name="password"]').element as HTMLInputElement).value).toBe("");
  expect(panel.text()).not.toContain("synthetic-password");
  await panel.get('button[type="button"]').trigger("click");
  await flushPromises();
  expect(panel.get('button[type="submit"]').attributes("disabled")).toBeUndefined();
  panel.unmount();
});
