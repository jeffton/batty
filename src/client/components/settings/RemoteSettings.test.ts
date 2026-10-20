import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { flushPromises, mount } from "@vue/test-utils";
import RemoteSettings from "./RemoteSettings.vue";
import {
  addRemoteConnection,
  getRemoteSettings,
  issueRemoteGrant,
  removeRemoteConnection,
  revokeRemoteGrant,
} from "@/client/lib/api";

vi.mock("@/client/lib/api", () => ({
  addRemoteConnection: vi.fn(),
  getRemoteSettings: vi.fn(),
  issueRemoteGrant: vi.fn(),
  removeRemoteConnection: vi.fn(),
  revokeRemoteGrant: vi.fn(),
}));

const settings = {
  instanceId: "local",
  connections: [{ id: "work", label: "Work", url: "https://work.test/batty/" }],
  grants: [{ id: "grant", label: "Home" }],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getRemoteSettings).mockResolvedValue(structuredClone(settings));
});
afterEach(() => vi.unstubAllGlobals());

function setup(open = true) {
  return mount(RemoteSettings, {
    props: { open },
    global: {
      stubs: {
        DeleteButton: {
          props: ["label", "disabled"],
          emits: ["confirm"],
          template:
            '<button :aria-label="label" :disabled="disabled" @click="$emit(\'confirm\')">Remove</button>',
        },
      },
    },
  });
}

it("loads only when open and uses existing provisioning actions for connections", async () => {
  const wrapper = setup(false);
  try {
    expect(getRemoteSettings).not.toHaveBeenCalled();
    await wrapper.setProps({ open: true });
    await flushPromises();
    expect(wrapper.text()).toContain("work · https://work.test/batty/");
    expect(wrapper.find("[placeholder]").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Connection ID");
    await wrapper.get('input[type="url"]').setValue("https://home.test/batty/");
    await wrapper.get('input[type="password"]').setValue(" private-token ");
    await wrapper.get("input").setValue("Home installation");
    vi.mocked(addRemoteConnection).mockRejectedValueOnce(
      new Error("Remote authentication required"),
    );
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe("Remote authentication required");
    expect(wrapper.get<HTMLInputElement>('input[type="password"]').element.value).toBe(
      " private-token ",
    );
    vi.mocked(addRemoteConnection).mockResolvedValueOnce({ ok: true });
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(addRemoteConnection).toHaveBeenLastCalledWith({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      label: "Home installation",
      url: "https://home.test/batty/",
      token: "private-token",
    });
    expect(wrapper.get<HTMLInputElement>('input[type="password"]').element.value).toBe("");
    vi.mocked(removeRemoteConnection).mockResolvedValueOnce({ ok: true });
    await wrapper.get('[aria-label="Remove connection Work"]').trigger("click");
    await flushPromises();
    expect(removeRemoteConnection).toHaveBeenCalledWith("work");
  } finally {
    wrapper.unmount();
  }
});

it("shows an issued token once, copies it, and clears all secrets when leaving the tab", async () => {
  const wrapper = setup();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  try {
    await flushPromises();
    await wrapper.findAll("form")[1]!.get("input").setValue("  Office  ");
    vi.mocked(issueRemoteGrant).mockResolvedValueOnce({ id: "new", token: "issued-secret" });
    await wrapper.findAll("form")[1]!.trigger("submit");
    await flushPromises();
    expect(issueRemoteGrant).toHaveBeenCalledWith("Office");
    expect(wrapper.get<HTMLTextAreaElement>("textarea").element.value).toBe("issued-secret");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Copy token")!
      .trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("issued-secret");
    await wrapper.get('input[type="password"]').setValue("draft-secret");
    await wrapper.setProps({ open: false });
    expect(wrapper.find("textarea").exists()).toBe(false);
    expect(wrapper.get<HTMLInputElement>('input[type="password"]').element.value).toBe("");
    await wrapper.setProps({ open: true });
    await flushPromises();
    expect(wrapper.find("textarea").exists()).toBe(false);
    vi.mocked(revokeRemoteGrant).mockRejectedValueOnce(new Error("Revoke failed"));
    await wrapper.get('[aria-label="Revoke access Home"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe("Revoke failed");
    vi.mocked(revokeRemoteGrant).mockResolvedValueOnce({ ok: true });
    await wrapper.get('[aria-label="Revoke access Home"]').trigger("click");
    await flushPromises();
    expect(revokeRemoteGrant).toHaveBeenLastCalledWith("grant");
  } finally {
    wrapper.unmount();
  }
});

it("does not reveal a token that arrives after the settings close", async () => {
  const wrapper = setup();
  try {
    await flushPromises();
    let finish!: (value: { id: string; token: string }) => void;
    vi.mocked(issueRemoteGrant).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await wrapper.findAll("form")[1]!.get("input").setValue("Late grant");
    await wrapper.findAll("form")[1]!.trigger("submit");
    await wrapper.setProps({ open: false });
    finish({ id: "late", token: "late-secret" });
    await flushPromises();
    await wrapper.setProps({ open: true });
    await flushPromises();
    expect(wrapper.find("textarea").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("late-secret");
  } finally {
    wrapper.unmount();
  }
});

it("keeps an in-flight mutation locked across reopen and never reveals its old token", async () => {
  const wrapper = setup();
  try {
    await flushPromises();
    let finish!: (value: { id: string; token: string }) => void;
    vi.mocked(issueRemoteGrant).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await wrapper.findAll("form")[1]!.get("input").setValue("Slow grant");
    await wrapper.findAll("form")[1]!.trigger("submit");
    expect(issueRemoteGrant).toHaveBeenCalledOnce();
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    await flushPromises();
    // Reopening must not start a faster GET that releases the mutation's lock.
    expect(getRemoteSettings).toHaveBeenCalledOnce();
    expect(wrapper.get("input").attributes("disabled")).toBeDefined();
    expect(wrapper.get('[aria-label="Revoke access Home"]').attributes("disabled")).toBeDefined();
    await wrapper.findAll("form")[1]!.trigger("submit");
    expect(issueRemoteGrant).toHaveBeenCalledOnce();
    finish({ id: "slow", token: "old-opening-secret" });
    await flushPromises();
    expect(getRemoteSettings).toHaveBeenCalledTimes(2);
    expect(wrapper.get("input").attributes("disabled")).toBeUndefined();
    expect(wrapper.find("textarea").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("old-opening-secret");
  } finally {
    wrapper.unmount();
  }
});

it("surfaces loading errors", async () => {
  vi.mocked(getRemoteSettings).mockRejectedValueOnce(new Error("Settings unavailable"));
  const wrapper = setup();
  try {
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe("Settings unavailable");
  } finally {
    wrapper.unmount();
  }
});
