import { flushPromises, mount } from "@vue/test-utils";
import { expect, test, vi } from "vite-plus/test";
import SessionReplyComposer from "./SessionReplyComposer.vue";
import { RpcError } from "@/shared/rpc";

test("a rejected send keeps the draft and retries the same request without double sending", async () => {
  const attempt = Promise.withResolvers<{ ok: true }>();
  const send = vi
    .fn<(text: string, id: string) => Promise<{ ok: true }>>()
    .mockReturnValueOnce(attempt.promise)
    .mockRejectedValueOnce(new RpcError("CONFLICT", "Session changed"))
    .mockResolvedValue({ ok: true });
  const wrapper = mount(SessionReplyComposer, { props: { enabled: true, send } });
  const input = wrapper.get("textarea");
  try {
    await input.setValue("   ");
    await wrapper.trigger("submit");
    expect(send).not.toHaveBeenCalled();

    await input.setValue("  Do the thing  ");
    await input.trigger("keydown", { key: "Enter", ctrlKey: true, isComposing: true });
    expect(send).not.toHaveBeenCalled();
    await input.trigger("keydown", { key: "Enter", ctrlKey: true });
    await wrapper.trigger("submit");
    expect(send).toHaveBeenCalledExactlyOnceWith("Do the thing", expect.any(String));

    attempt.reject(new Error("Connection lost"));
    await flushPromises();
    expect(input.element.value).toBe("  Do the thing  ");
    expect(wrapper.get('[role="alert"]').text()).toBe("Connection lost");

    await wrapper.trigger("submit");
    await flushPromises();
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
    expect(wrapper.get('[role="alert"]').text()).toBe("Session changed");

    await wrapper.trigger("submit");
    await flushPromises();
    expect(send.mock.calls[2]![1]).not.toBe(send.mock.calls[1]![1]);
    expect(input.element.value).toBe("");
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  } finally {
    wrapper.unmount();
  }
});
