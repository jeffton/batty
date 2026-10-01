import { shallowMount } from "@vue/test-utils";
import { nextTick } from "vue";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import MessageComposer from "./MessageComposer.vue";
import { readSessionDraft, writeSessionDraft } from "@/client/lib/session-draft";

const requiredProps = {
  modelPopoverId: "model-popover",
  modelPopoverAnchor: "--model-anchor",
  models: [],
  currentThinkingLevel: "medium",
  thinkingOptions: ["medium"],
  modelButtonLabel: "Model",
  thinkingButtonLabel: "Medium",
};

describe("MessageComposer", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("shows subagent activity while idle without changing send controls", async () => {
    const wrapper = shallowMount(MessageComposer, {
      props: { ...requiredProps, subagentCount: 2 },
    });

    const control = wrapper.getComponent({ name: "StreamingStopControl" });
    expect(control.props("subagentCount")).toBe(2);
    expect(control.props("hideStop")).toBe(true);
    expect(wrapper.get(".composer__send").attributes("aria-label")).toBe("Send prompt");
    expect(wrapper.find(".composer__steer").exists()).toBe(false);

    await wrapper.setProps({ streaming: true });
    expect(control.props("subagentCount")).toBe(0);
    expect(control.props("hideStop")).toBe(false);

    await wrapper.setProps({ streaming: false, subagentCount: 0 });
    expect(wrapper.findComponent({ name: "StreamingStopControl" }).exists()).toBe(false);
    wrapper.unmount();
  });

  it("disables browser autofill without disabling writing assistance", () => {
    const wrapper = shallowMount(MessageComposer, {
      props: { ...requiredProps, sessionKey: "session-a" },
    });
    const textarea = wrapper.get("textarea");

    expect(textarea.attributes("autocomplete")).toBe("off");
    expect(textarea.attributes("autocorrect")).toBe("on");
    expect(textarea.attributes("spellcheck")).toBe("true");
  });

  it("shows send errors in a red banner alongside the offline banner", () => {
    const wrapper = shallowMount(MessageComposer, {
      props: {
        ...requiredProps,
        error: "Batty is preparing to restart. Try again after restart.",
        offline: true,
      },
    });

    const notices = wrapper.findAll(".composer__notice");
    expect(notices).toHaveLength(2);
    expect(notices[0]?.text()).toBe("Batty is preparing to restart. Try again after restart.");
    expect(notices[0]?.classes()).toContain("composer__notice--error");
    expect(notices[1]?.text()).toBe("Offline. Draft saved locally");
  });

  it("restores a failed prompt only into its originating session", async () => {
    writeSessionDraft("session-b", "draft B");
    const wrapper = shallowMount(MessageComposer, {
      props: { ...requiredProps, sessionKey: "session-b" },
    });
    await nextTick();

    const restore = (
      wrapper.vm as unknown as {
        restore(sessionKey: string, text: string, files: File[]): void;
      }
    ).restore;
    restore("session-a", "failed A", [new File(["a"], "a.txt")]);
    await nextTick();

    expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("draft B");
    expect(readSessionDraft("session-b")).toBe("draft B");
    expect(readSessionDraft("session-a")).toBe("failed A");
    expect(wrapper.find(".composer__attachments").exists()).toBe(false);

    await wrapper.setProps({ sessionKey: "session-a" });
    await nextTick();
    expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("failed A");
    expect(wrapper.get(".composer__attachments").text()).toContain("a.txt");
  });

  it("places attached files below queued prompts", async () => {
    const wrapper = shallowMount(MessageComposer, {
      props: {
        ...requiredProps,
        sessionKey: "session-a",
        queuedPrompts: [{ kind: "followUp", index: 0, text: "next prompt" }],
      },
    });
    await nextTick();

    const restore = (
      wrapper.vm as unknown as {
        restore(sessionKey: string, text: string, files: File[]): void;
      }
    ).restore;
    restore("session-a", "", [new File(["a"], "a.txt")]);
    await nextTick();

    const children = Array.from(wrapper.get(".composer__inner").element.children);
    expect(children.indexOf(wrapper.get("composer-queued-prompts-stub").element)).toBeLessThan(
      children.indexOf(wrapper.get(".composer__attachments").element),
    );
  });

  it("does not replace newer composer input when an earlier prompt fails", async () => {
    const wrapper = shallowMount(MessageComposer, {
      props: { ...requiredProps, sessionKey: "session-a" },
    });
    const textarea = wrapper.get("textarea");
    await textarea.setValue("new input");

    const restore = (
      wrapper.vm as unknown as {
        restore(sessionKey: string, text: string, files: File[]): void;
      }
    ).restore;
    restore("session-a", "failed prompt", []);
    await nextTick();

    expect((textarea.element as HTMLTextAreaElement).value).toBe("new input");
  });
});
