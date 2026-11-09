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
  instanceId: "local-private-id",
  connections: [
    {
      id: "work-private-id",
      label: "Work",
      url: "https://work.test/batty/",
      status: { state: "connected" as const },
    },
  ],
  grants: [{ id: "grant", label: "Unused token" }],
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

function generate(wrapper: ReturnType<typeof setup>) {
  return wrapper
    .findAll("button")
    .find((button) => button.text() === "Generate token")!
    .trigger("click");
}

it("offers only URL and token inputs and sends only those fields when adding", async () => {
  const wrapper = setup(false);
  try {
    expect(getRemoteSettings).not.toHaveBeenCalled();
    await wrapper.setProps({ open: true });
    await flushPromises();
    expect(wrapper.text()).toContain("Work");
    expect(wrapper.text()).toContain("Online");
    expect(wrapper.text()).toContain("https://work.test/batty/");
    expect(wrapper.text()).not.toContain("private-id");
    expect(wrapper.findAll("input")).toHaveLength(2);
    expect(wrapper.get("form").attributes("autocomplete")).toBe("off");
    expect(wrapper.get('input[name="pairing-url"]').attributes("type")).toBe("url");
    const tokenInput = wrapper.get('input[name="pairing-token"]');
    expect(tokenInput.attributes("type")).toBe("text");
    expect(tokenInput.attributes("autocomplete")).toBe("one-time-code");
    expect(wrapper.find('input[type="password"]').exists()).toBe(false);
    expect(wrapper.find("select").exists()).toBe(false);
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false);
    expect(wrapper.findAll("form")).toHaveLength(1);
    await wrapper.get('input[type="url"]').setValue("https://home.test/batty/");
    await wrapper.get('input[name="pairing-token"]').setValue(" private-token ");
    vi.mocked(addRemoteConnection).mockRejectedValueOnce(new Error("Token already used"));
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe("Token already used");
    expect(wrapper.get<HTMLInputElement>('input[name="pairing-token"]').element.value).toBe(
      " private-token ",
    );
    vi.mocked(addRemoteConnection).mockResolvedValueOnce({ ok: true });
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(addRemoteConnection).toHaveBeenLastCalledWith({
      url: "https://home.test/batty/",
      token: "private-token",
    });
    expect(wrapper.get<HTMLInputElement>('input[name="pairing-token"]').element.value).toBe("");
    vi.mocked(removeRemoteConnection).mockResolvedValueOnce({ ok: true });
    await wrapper.get('[aria-label="Remove connection Work"]').trigger("click");
    await flushPromises();
    expect(removeRemoteConnection).toHaveBeenCalledWith("work-private-id");
  } finally {
    wrapper.unmount();
  }
});

it("generates without a label, copies the token and clears secrets on close", async () => {
  const wrapper = setup();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  try {
    await flushPromises();
    vi.mocked(issueRemoteGrant).mockResolvedValueOnce({ id: "new", token: "issued-secret" });
    await generate(wrapper);
    await flushPromises();
    expect(issueRemoteGrant).toHaveBeenCalledWith();
    expect(wrapper.get<HTMLTextAreaElement>("textarea").element.value).toBe("issued-secret");
    expect(wrapper.get("textarea").attributes("readonly")).toBeDefined();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Copy token")!
      .trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("issued-secret");
    await wrapper.get('input[name="pairing-token"]').setValue("draft-secret");
    await wrapper.setProps({ open: false });
    expect(wrapper.find("textarea").exists()).toBe(false);
    expect(wrapper.get<HTMLInputElement>('input[name="pairing-token"]').element.value).toBe("");
    await wrapper.setProps({ open: true });
    await flushPromises();
    expect(wrapper.find("textarea").exists()).toBe(false);
  } finally {
    wrapper.unmount();
  }
});

it("cancels unused tokens and clears a cancelled generated secret", async () => {
  const wrapper = setup();
  try {
    await flushPromises();
    vi.mocked(issueRemoteGrant).mockResolvedValueOnce({ id: "grant", token: "issued-secret" });
    await generate(wrapper);
    await flushPromises();
    vi.mocked(revokeRemoteGrant).mockRejectedValueOnce(new Error("Cancel failed"));
    await wrapper.get('[aria-label="Cancel unused token"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe("Cancel failed");
    expect(wrapper.find("textarea").exists()).toBe(true);
    vi.mocked(revokeRemoteGrant).mockResolvedValueOnce({ ok: true });
    await wrapper.get('[aria-label="Cancel unused token"]').trigger("click");
    await flushPromises();
    expect(revokeRemoteGrant).toHaveBeenLastCalledWith("grant");
    expect(wrapper.find("textarea").exists()).toBe(false);
  } finally {
    wrapper.unmount();
  }
});

it("keeps an in-flight generation locked across reopen without revealing its secret", async () => {
  const wrapper = setup();
  try {
    await flushPromises();
    let finish!: (value: { id: string; token: string }) => void;
    vi.mocked(issueRemoteGrant).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await generate(wrapper);
    expect(issueRemoteGrant).toHaveBeenCalledOnce();
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    await flushPromises();
    expect(getRemoteSettings).toHaveBeenCalledOnce();
    expect(wrapper.get("form").get("input").attributes("disabled")).toBeDefined();
    await generate(wrapper);
    expect(issueRemoteGrant).toHaveBeenCalledOnce();
    finish({ id: "slow", token: "old-opening-secret" });
    await flushPromises();
    expect(getRemoteSettings).toHaveBeenCalledTimes(2);
    expect(wrapper.get("form").get("input").attributes("disabled")).toBeUndefined();
    expect(wrapper.find("textarea").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("old-opening-secret");
  } finally {
    wrapper.unmount();
  }
});

it("discards a generated token arriving while settings are closed", async () => {
  const wrapper = setup();
  try {
    await flushPromises();
    let finish!: (value: { id: string; token: string }) => void;
    vi.mocked(issueRemoteGrant).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await generate(wrapper);
    await wrapper.setProps({ open: false });
    finish({ id: "late", token: "late-secret" });
    await flushPromises();
    await wrapper.setProps({ open: true });
    await flushPromises();
    expect(wrapper.find("textarea").exists()).toBe(false);
  } finally {
    wrapper.unmount();
  }
});

it("shows connection states and refreshes explicitly", async () => {
  vi.mocked(getRemoteSettings).mockResolvedValue({
    ...settings,
    connections: [
      { id: "offline", label: "Offline peer", url: "" },
      { id: "connecting", label: "Waking peer", url: "", status: { state: "connecting" } },
      {
        id: "error",
        label: "Unreachable peer",
        url: "",
        status: { state: "error", error: "Connection lost" },
      },
    ],
  });
  const wrapper = setup();
  try {
    await flushPromises();
    expect(wrapper.text()).toContain("Offline");
    expect(wrapper.text()).toContain("Connecting");
    expect(wrapper.get('[role="alert"]').text()).toBe("Connection lost");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Refresh")!
      .trigger("click");
    await flushPromises();
    expect(getRemoteSettings).toHaveBeenCalledTimes(2);
  } finally {
    wrapper.unmount();
  }
});

it("surfaces loading and generation errors", async () => {
  vi.mocked(getRemoteSettings).mockRejectedValueOnce(new Error("Settings unavailable"));
  const wrapper = setup();
  try {
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe("Settings unavailable");
    vi.mocked(issueRemoteGrant).mockRejectedValueOnce(new Error("Could not generate token"));
    await generate(wrapper);
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe("Could not generate token");
  } finally {
    wrapper.unmount();
  }
});
