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
};
const target = {
  pageId: state.pageId,
  revision: state.revision,
  url: state.url,
  origin: "https://login.example",
  token: "document-token",
};
afterEach(() => vi.unstubAllGlobals());

test("local login uses standard autofill fields and transmits only on explicit submit, clearing on success", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => target })
    .mockResolvedValueOnce({ ok: true });
  vi.stubGlobal("fetch", fetch);
  const panel = mount(BrowserCredentials, { props: { browserId: "session", state } });
  await flushPromises();
  expect(panel.text()).toContain(target.origin);
  expect(panel.get('[name="username"]').attributes("autocomplete")).toBe("username");
  expect(panel.get('[name="password"]').attributes("autocomplete")).toBe("current-password");
  await panel.get('[name="username"]').setValue("test-user");
  await panel.get('[name="password"]').setValue("test-password");
  expect(fetch).toHaveBeenCalledTimes(1);
  await panel.get("form").trigger("submit");
  await flushPromises();
  expect(fetch.mock.calls[1]![0]).toBe("/api/cloud-browser/session/credentials/fill");
  expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({
    target,
    username: "test-user",
    password: "test-password",
  });
  expect((panel.get('[name="password"]').element as HTMLInputElement).value).toBe("");
  expect(panel.emitted("close")).toHaveLength(1);
  panel.unmount();
});

test("navigation clears local credentials without transmitting them", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => target });
  vi.stubGlobal("fetch", fetch);
  const panel = mount(BrowserCredentials, { props: { browserId: "session", state } });
  await flushPromises();
  await panel.get('[name="password"]').setValue("test-secret");
  await panel.setProps({ state: { ...state, revision: "navigation" } });
  expect((panel.get('[name="password"]').element as HTMLInputElement).value).toBe("");
  expect(panel.emitted("close")).toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  panel.unmount();
});

test("failed handoff clears values and never displays transport error details", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => target })
    .mockRejectedValueOnce(new Error("test-password"));
  vi.stubGlobal("fetch", fetch);
  const panel = mount(BrowserCredentials, { props: { browserId: "session", state } });
  await flushPromises();
  await panel.get('[name="password"]').setValue("test-password");
  await panel.get("form").trigger("submit");
  await flushPromises();
  expect(panel.find("form").exists()).toBe(false);
  expect(panel.text()).not.toContain("test-password");
  expect(panel.get('[role="alert"]').text()).toContain("Close and reopen");
  panel.unmount();
});
